"""Offline tests for runtime/tts/worker.py. No model files, no network."""

import io
import json
import struct
import sys
import unittest
import wave
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "runtime" / "tts"))

import worker  # noqa: E402


class FakeBackend:
    """Minimal backend double matching worker.Backend's protocol."""

    def __init__(self, root, engine, device):
        self.root = root
        self.engine = engine
        self.device = device
        self.prepared_languages = []
        self.synth_calls = []
        self.voices = ["af_heart", "ff_siwis"]
        self.fail_synth = False

    def prepare(self, language):
        self.prepared_languages.append(language)
        return list(self.voices)

    def synthesize(self, text, language, voice, speed):
        self.synth_calls.append((text, language, voice, speed))
        if self.fail_synth:
            raise worker.BackendError("synthesis exploded")
        # One channel of silence: enough for the WAV encoder to run for real.
        return [0.0, 0.1, -0.1, 0.2], 24000


def make_worker(device="cpu", backend=None):
    created = {}

    def factory(root, engine, resolved_device):
        nonlocal backend
        if backend is None:
            backend = FakeBackend(root, engine, resolved_device)
        created["backend"] = backend
        return backend

    def resolver(engine, requested):
        if requested == "gpu":
            raise worker.BackendError("gpu requested but CUDA is unavailable")
        return device

    w = worker.Worker(
        Path("/fake/root"),
        "kokoro",
        backend_factory=factory,
        device_resolver=resolver,
    )
    return w, created


class WavEncodingTests(unittest.TestCase):
    def test_wav_bytes_round_trip(self):
        data = worker._wav_bytes([0.0, 1.0, -1.0], 16000)
        with wave.open(io.BytesIO(data), "rb") as wav:
            self.assertEqual(wav.getnchannels(), 1)
            self.assertEqual(wav.getsampwidth(), 2)
            self.assertEqual(wav.getframerate(), 16000)
            frames = wav.readframes(3)
            samples = struct.unpack("<3h", frames)
            self.assertEqual(samples[0], 0)
            self.assertGreater(samples[1], 0)
            self.assertLess(samples[2], 0)

    def test_wav_bytes_rejects_bad_sample_rate(self):
        with self.assertRaises(worker.BackendError):
            worker._wav_bytes([0.0], 0)


class RequestValidationTests(unittest.TestCase):
    def test_missing_id_rejected(self):
        w, _ = make_worker()
        with self.assertRaises(worker.RequestError):
            w.handle({"text": "hi", "language": "en", "voice": "af_heart", "speed": 1.0, "device": "cpu"})

    def test_text_too_long_rejected(self):
        w, _ = make_worker()
        with self.assertRaises(worker.RequestError):
            w.handle({
                "id": "1", "text": "x" * (worker.MAX_TEXT_CHARS + 1),
                "language": "en", "voice": "af_heart", "speed": 1.0, "device": "cpu",
            })

    def test_empty_text_rejected(self):
        w, _ = make_worker()
        with self.assertRaises(worker.RequestError):
            w.handle({"id": "1", "text": "   ", "language": "en", "voice": "af_heart", "speed": 1.0, "device": "cpu"})

    def test_bad_speed_rejected(self):
        w, _ = make_worker()
        with self.assertRaises(worker.RequestError):
            w.handle({"id": "1", "text": "hi", "language": "en", "voice": "af_heart", "speed": 9.0, "device": "cpu"})

    def test_bool_speed_rejected(self):
        w, _ = make_worker()
        with self.assertRaises(worker.RequestError):
            w.handle({"id": "1", "text": "hi", "language": "en", "voice": "af_heart", "speed": True, "device": "cpu"})

    def test_kokoro_rejects_arabic(self):
        w, _ = make_worker()
        with self.assertRaises(worker.RequestError):
            w.handle({"id": "1", "text": "hi", "language": "ar", "voice": "af_heart", "speed": 1.0, "device": "cpu"})

    def test_unknown_field_rejected(self):
        w, _ = make_worker()
        with self.assertRaises(worker.RequestError):
            w.handle({
                "id": "1", "text": "hi", "language": "en", "voice": "af_heart",
                "speed": 1.0, "device": "cpu", "extra": True,
            })

    def test_voice_not_in_loaded_model_rejected(self):
        # FakeBackend does not enforce language-prefix matching (that lives
        # in KokoroBackend); exercise the request-shape check this test
        # owns: an unknown voice is a plain RequestError from the backend.
        backend = FakeBackend(Path("/fake"), "kokoro", "cpu")
        backend.voices = ["af_heart"]

        def rejecting_synthesize(text, language, voice, speed):
            if voice not in backend.voices:
                raise worker.RequestError("voice is not available in loaded model")
            return [0.0], 24000

        backend.synthesize = rejecting_synthesize
        w, _ = make_worker(backend=backend)
        with self.assertRaises(worker.RequestError):
            w.handle({"id": "1", "text": "hi", "language": "en", "voice": "missing_voice", "speed": 1.0, "device": "cpu"})


class SynthesisTests(unittest.TestCase):
    def test_successful_synthesis_returns_base64_wav(self):
        w, created = make_worker()
        response = w.handle({"id": "1", "text": "hi", "language": "en", "voice": "af_heart", "speed": 1.0, "device": "cpu"})
        self.assertEqual(response["id"], "1")
        self.assertEqual(response["device"], "cpu")
        self.assertEqual(response["sampleRate"], 24000)
        self.assertIn("audio", response)
        import base64
        wav_bytes = base64.b64decode(response["audio"])
        with wave.open(io.BytesIO(wav_bytes), "rb") as wav:
            self.assertEqual(wav.getframerate(), 24000)
        self.assertEqual(created["backend"].synth_calls, [("hi", "en", "af_heart", 1.0)])

    def test_backend_synthesis_failure_propagates_as_backend_error(self):
        backend = FakeBackend(Path("/fake"), "kokoro", "cpu")
        backend.fail_synth = True
        w, _ = make_worker(backend=backend)
        with self.assertRaises(worker.BackendError):
            w.handle({"id": "1", "text": "hi", "language": "en", "voice": "af_heart", "speed": 1.0, "device": "cpu"})

    def test_gpu_request_without_cuda_raises(self):
        w, _ = make_worker()
        with self.assertRaises(worker.BackendError):
            w.handle({"id": "1", "text": "hi", "language": "en", "voice": "af_heart", "speed": 1.0, "device": "gpu"})

    def test_switching_device_on_loaded_backend_rejected(self):
        w, created = make_worker(device="cpu")
        w.handle({"id": "1", "text": "hi", "language": "en", "voice": "af_heart", "speed": 1.0, "device": "cpu"})
        # Backend stays bound to its first resolved device; a later request with
        # a different already-loaded device must fail instead of silently
        # switching hardware under a long-lived model.
        created["backend"].device = "cpu"
        w._device_resolver = lambda engine, requested: "gpu" if requested == "gpu" else "cpu"
        with self.assertRaises(worker.BackendError):
            w.handle({"id": "2", "text": "hi", "language": "en", "voice": "af_heart", "speed": 1.0, "device": "gpu"})


class StatusOpTests(unittest.TestCase):
    def test_status_returns_voices_and_device(self):
        w, created = make_worker()
        response = w.handle({"id": "s1", "op": "status", "language": "en", "device": "cpu"})
        self.assertTrue(response["ready"])
        self.assertEqual(response["engine"], "kokoro")
        self.assertEqual(response["voices"], ["af_heart", "ff_siwis"])
        self.assertEqual(created["backend"].prepared_languages, ["en"])

    def test_status_rejects_unknown_field(self):
        w, _ = make_worker()
        with self.assertRaises(worker.RequestError):
            w.handle({"id": "s1", "op": "status", "voice": "af_heart"})

    def test_unknown_op_rejected(self):
        w, _ = make_worker()
        with self.assertRaises(worker.RequestError):
            w.handle({"id": "s1", "op": "synthesize"})


class ServeProtocolTests(unittest.TestCase):
    def test_serve_handles_one_request_and_stops_on_eof(self):
        w, _ = make_worker()
        request = {"id": "1", "text": "hi", "language": "en", "voice": "af_heart", "speed": 1.0, "device": "cpu"}
        stdin = io.BytesIO((json.dumps(request) + "\n").encode("utf-8"))
        stdout = io.BytesIO()
        worker.serve(w, stdin, stdout)
        line = stdout.getvalue().decode("utf-8").strip()
        response = json.loads(line)
        self.assertEqual(response["id"], "1")
        self.assertIn("audio", response)

    def test_serve_reports_invalid_json_without_crashing(self):
        w, _ = make_worker()
        stdin = io.BytesIO(b"not json\n")
        stdout = io.BytesIO()
        worker.serve(w, stdin, stdout)
        response = json.loads(stdout.getvalue().decode("utf-8").strip())
        self.assertIn("error", response)

    def test_serve_rejects_oversized_line(self):
        w, _ = make_worker()
        huge = json.dumps({"id": "1", "text": "x" * 20000}) + "\n"
        stdin = io.BytesIO(huge.encode("utf-8"))
        stdout = io.BytesIO()
        worker.serve(w, stdin, stdout)
        response = json.loads(stdout.getvalue().decode("utf-8").strip())
        self.assertIn("error", response)
        self.assertIn("16 KiB", response["error"])

    def test_serve_processes_multiple_requests_in_order(self):
        w, _ = make_worker()
        requests = [
            {"id": "1", "text": "hi", "language": "en", "voice": "af_heart", "speed": 1.0, "device": "cpu"},
            {"id": "2", "op": "status", "language": "en", "device": "cpu"},
        ]
        stdin = io.BytesIO(("\n".join(json.dumps(r) for r in requests) + "\n").encode("utf-8"))
        stdout = io.BytesIO()
        worker.serve(w, stdin, stdout)
        lines = [json.loads(l) for l in stdout.getvalue().decode("utf-8").splitlines()]
        self.assertEqual([r["id"] for r in lines], ["1", "2"])


if __name__ == "__main__":
    unittest.main()
