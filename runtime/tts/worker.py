#!/usr/bin/env python3
"""Persistent JSON-lines worker for local text-to-speech engines."""

from __future__ import annotations

import argparse
import base64
import contextlib
import gc
import importlib
import importlib.resources
import io
import json
import math
import os
import struct
import sys
import wave
from pathlib import Path
from typing import Any, BinaryIO, Callable, Protocol

MAX_LINE_BYTES = 16 * 1024
MAX_TEXT_CHARS = 1000
LANGUAGES = frozenset({"en", "fr", "it", "zh", "ar"})
DEVICES = frozenset({"auto", "cpu", "gpu"})
KOKORO_LANGS = {"en": "en-us", "fr": "fr-fr", "it": "it", "zh": "cmn"}
KOKORO_PREFIXES = {
    "en": ("af_", "am_", "bf_", "bm_"),
    "fr": ("ff_", "fm_"),
    "it": ("if_", "im_"),
    "zh": ("zf_", "zm_"),
}
HABIBI_VOICES = ("MSA", "ALG", "SAU", "UAE", "IRQ", "EGY", "MAR")
ALG_REFERENCE_TEXT = "أنيا هكا باغية ناكل هكا أني ن نشوف فيها الحاجة هذيكا."

# Prevent dependency helpers from silently fetching missing model data.
os.environ.setdefault("HF_HUB_OFFLINE", "1")
os.environ.setdefault("TRANSFORMERS_OFFLINE", "1")
os.environ.setdefault("HF_DATASETS_OFFLINE", "1")
os.environ.setdefault("IMAGEIO_NO_INTERNET", "1")


class RequestError(Exception):
    """Safe request error suitable for returning to caller."""


class BackendError(Exception):
    """Safe backend error suitable for returning to caller."""


class Backend(Protocol):
    device: str

    def prepare(self, language: str) -> list[str]: ...

    def synthesize(
        self, text: str, language: str, voice: str, speed: float
    ) -> tuple[Any, int]: ...


BackendFactory = Callable[[Path, str, str], Backend]
DeviceResolver = Callable[[str, str], str]


def _library_output_to_stderr():
    return contextlib.redirect_stdout(sys.stderr)


def _import_module(name: str):
    try:
        with _library_output_to_stderr():
            return importlib.import_module(name)
    except ImportError as error:
        raise BackendError(f"required dependency unavailable: {name}") from error


def _require_files(paths: list[Path]) -> None:
    missing = [path.name for path in paths if not path.is_file()]
    if missing:
        raise BackendError(f"missing local model file: {missing[0]}")


def resolve_device(engine: str, requested: str) -> str:
    if engine == "kokoro":
        runtime = _import_module("onnxruntime")
        with _library_output_to_stderr():
            cuda_available = "CUDAExecutionProvider" in runtime.get_available_providers()
    else:
        torch = _import_module("torch")
        with _library_output_to_stderr():
            cuda_available = bool(torch.cuda.is_available())

    if requested == "gpu" and not cuda_available:
        raise BackendError("gpu requested but CUDA is unavailable")
    if requested == "auto":
        return "gpu" if cuda_available else "cpu"
    return requested


def _wav_bytes(audio: Any, sample_rate: int) -> bytes:
    if not isinstance(sample_rate, int) or sample_rate <= 0:
        raise BackendError("engine returned invalid sample rate")

    numpy = _import_module("numpy")
    try:
        samples = numpy.asarray(audio, dtype=numpy.float32).reshape(-1)
        samples = numpy.nan_to_num(samples, nan=0.0, posinf=1.0, neginf=-1.0)
        pcm = (numpy.clip(samples, -1.0, 1.0) * 32767.0).astype("<i2").tobytes()
    except Exception as error:
        raise BackendError("engine returned invalid audio") from error

    output = io.BytesIO()
    with wave.open(output, "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(sample_rate)
        wav.writeframes(pcm)
    return output.getvalue()


class KokoroBackend:
    def __init__(self, root: Path, device: str):
        self.root = root
        self.device = device
        os.environ["ONNX_PROVIDER"] = (
            "CUDAExecutionProvider" if device == "gpu" else "CPUExecutionProvider"
        )
        module = _import_module("kokoro_onnx")
        try:
            self._kokoro_class = module.Kokoro
        except AttributeError as error:
            raise BackendError("kokoro-onnx has incompatible API") from error
        self._model: Any | None = None
        self._model_group: str | None = None
        self._voices: list[str] = []
        self._zh_g2p: Any | None = None

    @staticmethod
    def _group(language: str) -> str:
        return "kokoro-zh" if language == "zh" else "kokoro"

    def prepare(self, language: str) -> list[str]:
        group = self._group(language)
        if group == self._model_group and self._model is not None:
            return list(self._voices)

        directory = self.root / group
        model_path = directory / "model.onnx"
        voices_path = directory / "voices.bin"
        _require_files([model_path, voices_path])

        # Release old graph before loading another language model.
        self._model = None
        self._model_group = None
        self._voices = []
        gc.collect()
        try:
            with _library_output_to_stderr():
                model = self._kokoro_class(str(model_path), str(voices_path))
                voices = model.get_voices()
        except Exception as error:
            raise BackendError("kokoro model initialization failed") from error

        self._model = model
        self._model_group = group
        self._voices = sorted(str(voice) for voice in voices)
        return list(self._voices)

    def _validate_voice(self, language: str, voice: str) -> None:
        if voice not in self._voices:
            raise RequestError("voice is not available in loaded model")
        if not voice.startswith(KOKORO_PREFIXES[language]):
            raise RequestError(f"voice does not match language {language}")

    def synthesize(
        self, text: str, language: str, voice: str, speed: float
    ) -> tuple[Any, int]:
        self.prepare(language)
        self._validate_voice(language, voice)
        assert self._model is not None
        try:
            with _library_output_to_stderr():
                if language == "zh":
                    if self._zh_g2p is None:
                        zh = _import_module("misaki.zh")
                        self._zh_g2p = zh.ZHG2P(version="1.1")
                    phonemes = self._zh_g2p(text)[0]
                    return self._model.create(
                        phonemes,
                        voice=voice,
                        speed=speed,
                        lang=KOKORO_LANGS[language],
                        is_phonemes=True,
                    )
                return self._model.create(
                    text,
                    voice=voice,
                    speed=speed,
                    lang=KOKORO_LANGS[language],
                )
        except RequestError:
            raise
        except Exception as error:
            raise BackendError("kokoro synthesis failed") from error


class HabibiBackend:
    def __init__(self, root: Path, device: str):
        self.root = root
        self.device = device
        self._torch_device = "cuda" if device == "gpu" else "cpu"
        self._ready = False
        self._model: Any | None = None
        self._vocoder: Any | None = None
        self._infer_process: Any | None = None
        self._dialect_ids: dict[str, Any] = {}
        self._ref_audio = ""
        self._ref_text = ALG_REFERENCE_TEXT
        self._mel_spec_type = "vocos"

    def _configure_ffmpeg(self) -> None:
        imageio_ffmpeg = _import_module("imageio_ffmpeg")
        try:
            executable = imageio_ffmpeg.get_ffmpeg_exe()
        except Exception as error:
            raise BackendError("bundled ffmpeg is unavailable") from error
        executable_path = Path(executable)
        if not executable_path.is_file():
            raise BackendError("bundled ffmpeg is unavailable")
        os.environ["PATH"] = f"{executable_path.parent}{os.pathsep}{os.environ.get('PATH', '')}"
        pydub = _import_module("pydub")
        pydub.AudioSegment.converter = str(executable_path)
        pydub.AudioSegment.ffmpeg = str(executable_path)

    def prepare(self, language: str) -> list[str]:
        if self._ready:
            return [voice for voice in HABIBI_VOICES if voice in self._dialect_ids]

        directory = self.root / "habibi"
        checkpoint = directory / "model.safetensors"
        vocab = directory / "vocab.txt"
        vocoder_dir = directory / "vocos"
        vocoder_config = vocoder_dir / "config.yaml"
        vocoder_model = vocoder_dir / "pytorch_model.bin"
        reference = directory / "reference.wav"
        _require_files([checkpoint, vocab, vocoder_config, vocoder_model, reference])
        self._configure_ffmpeg()

        omega = _import_module("omegaconf")
        hydra = _import_module("hydra.utils")
        f5_utils = _import_module("f5_tts.infer.utils_infer")
        habibi_utils = _import_module("habibi_tts.infer.utils_infer")
        dialect_utils = _import_module("habibi_tts.model.utils")

        try:
            config_path = importlib.resources.files("f5_tts").joinpath(
                "configs/F5TTS_v1_Base.yaml"
            )
            config = omega.OmegaConf.load(str(config_path))
            model_class = hydra.get_class(f"f5_tts.model.{config.model.backbone}")
            self._mel_spec_type = str(config.model.mel_spec.mel_spec_type)
            with _library_output_to_stderr():
                model = f5_utils.load_model(
                    model_class,
                    config.model.arch,
                    str(checkpoint),
                    mel_spec_type=self._mel_spec_type,
                    vocab_file=str(vocab),
                    device=self._torch_device,
                )
                vocoder = f5_utils.load_vocoder(
                    vocoder_name=self._mel_spec_type,
                    is_local=True,
                    local_path=str(vocoder_dir),
                    device=self._torch_device,
                )
                ref_audio, ref_text = f5_utils.preprocess_ref_audio_text(
                    str(reference), ALG_REFERENCE_TEXT, show_info=print
                )
        except Exception as error:
            raise BackendError("habibi model initialization failed") from error

        self._model = model
        self._vocoder = vocoder
        self._infer_process = habibi_utils.infer_process
        self._dialect_ids = dict(dialect_utils.dialect_id_map)
        self._ref_audio = ref_audio
        self._ref_text = ref_text
        self._ready = True
        return [voice for voice in HABIBI_VOICES if voice in self._dialect_ids]

    def synthesize(
        self, text: str, language: str, voice: str, speed: float
    ) -> tuple[Any, int]:
        voices = self.prepare(language)
        if voice not in voices:
            raise RequestError("voice is not an available Habibi dialect")
        try:
            with _library_output_to_stderr():
                audio, sample_rate, _ = self._infer_process(
                    self._ref_audio,
                    self._ref_text,
                    text,
                    self._model,
                    self._vocoder,
                    mel_spec_type=self._mel_spec_type,
                    speed=speed,
                    device=self._torch_device,
                    dialect_id=self._dialect_ids[voice],
                    show_info=print,
                    progress=None,
                )
        except Exception as error:
            raise BackendError("habibi synthesis failed") from error
        if audio is None:
            raise BackendError("habibi synthesis returned no audio")
        return audio, int(sample_rate)


def create_backend(root: Path, engine: str, device: str) -> Backend:
    if engine == "kokoro":
        return KokoroBackend(root, device)
    return HabibiBackend(root, device)


def _validate_id(request: dict[str, Any]) -> str | int:
    if "id" not in request:
        raise RequestError("id is required")
    request_id = request["id"]
    if type(request_id) not in (str, int):
        raise RequestError("id must be a string or integer")
    if isinstance(request_id, str) and (not request_id or len(request_id) > 128):
        raise RequestError("id string must contain 1 to 128 characters")
    return request_id


def _validate_device(value: Any, *, required: bool) -> str:
    if value is None and not required:
        return "auto"
    if not isinstance(value, str) or value not in DEVICES:
        raise RequestError("device must be auto, cpu, or gpu")
    return value


def _validate_language(value: Any, engine: str, *, required: bool) -> str:
    if value is None and not required:
        return "en" if engine == "kokoro" else "ar"
    if not isinstance(value, str) or value not in LANGUAGES:
        raise RequestError("language must be en, fr, it, zh, or ar")
    if engine == "kokoro" and value == "ar":
        raise RequestError("kokoro does not support language ar")
    if engine == "habibi" and value != "ar":
        raise RequestError("habibi only supports language ar")
    return value


class Worker:
    def __init__(
        self,
        root: Path,
        engine: str,
        *,
        backend_factory: BackendFactory = create_backend,
        device_resolver: DeviceResolver = resolve_device,
        wav_encoder: Callable[[Any, int], bytes] = _wav_bytes,
    ):
        self.root = root
        self.engine = engine
        self._backend_factory = backend_factory
        self._device_resolver = device_resolver
        self._wav_encoder = wav_encoder
        self._backend: Backend | None = None

    def _ensure_backend(self, requested_device: str) -> Backend:
        device = self._device_resolver(self.engine, requested_device)
        if self._backend is None:
            self._backend = self._backend_factory(self.root, self.engine, device)
        elif self._backend.device != device:
            raise BackendError(
                f"worker model already loaded on {self._backend.device}; requested {device}"
            )
        return self._backend

    def handle(self, request: Any) -> dict[str, Any]:
        if not isinstance(request, dict):
            raise RequestError("request must be a JSON object")
        request_id = _validate_id(request)
        op = request.get("op")
        if op == "status":
            allowed = {"id", "op", "language", "device"}
            unknown = sorted(set(request) - allowed)
            if unknown:
                raise RequestError(f"unknown field: {unknown[0]}")
            language = _validate_language(
                request.get("language"), self.engine, required=False
            )
            requested_device = _validate_device(
                request.get("device"), required=False
            )
            backend = self._ensure_backend(requested_device)
            voices = backend.prepare(language)
            return {
                "id": request_id,
                "ready": True,
                "engine": self.engine,
                "language": language,
                "device": backend.device,
                "voices": voices,
            }
        if op is not None:
            raise RequestError("op must be status when provided")

        allowed = {"id", "text", "language", "voice", "speed", "device"}
        unknown = sorted(set(request) - allowed)
        if unknown:
            raise RequestError(f"unknown field: {unknown[0]}")

        text = request.get("text")
        if not isinstance(text, str):
            raise RequestError("text must be a string")
        if not text.strip():
            raise RequestError("text must not be empty")
        if len(text) > MAX_TEXT_CHARS:
            raise RequestError(f"text exceeds {MAX_TEXT_CHARS} characters")
        language = _validate_language(request.get("language"), self.engine, required=True)
        voice = request.get("voice")
        if not isinstance(voice, str) or not voice or len(voice) > 64:
            raise RequestError("voice must contain 1 to 64 characters")
        speed = request.get("speed")
        if isinstance(speed, bool) or not isinstance(speed, (int, float)):
            raise RequestError("speed must be a number")
        speed = float(speed)
        if not math.isfinite(speed) or not 0.5 <= speed <= 2.0:
            raise RequestError("speed must be between 0.5 and 2.0")
        requested_device = _validate_device(request.get("device"), required=True)

        backend = self._ensure_backend(requested_device)
        audio, sample_rate = backend.synthesize(text, language, voice, speed)
        wav = self._wav_encoder(audio, sample_rate)
        return {
            "id": request_id,
            "audio": base64.b64encode(wav).decode("ascii"),
            "sampleRate": sample_rate,
            "device": backend.device,
        }


def _error_response(request_id: Any, error: Exception) -> dict[str, Any]:
    if isinstance(error, (RequestError, BackendError)):
        message = str(error)
    else:
        message = "internal worker error"
    return {"id": request_id, "error": message[:240]}


def _write_response(stdout: BinaryIO, response: dict[str, Any]) -> None:
    data = json.dumps(
        response, ensure_ascii=False, separators=(",", ":"), allow_nan=False
    ).encode("utf-8")
    stdout.write(data + b"\n")
    stdout.flush()


def serve(worker: Worker, stdin: BinaryIO, stdout: BinaryIO) -> None:
    while True:
        raw = stdin.readline(MAX_LINE_BYTES + 2)
        if raw == b"":
            return
        if not raw.endswith(b"\n") and len(raw) > MAX_LINE_BYTES:
            while raw and not raw.endswith(b"\n"):
                raw = stdin.readline(MAX_LINE_BYTES + 2)
            _write_response(stdout, _error_response(None, RequestError("stdin line exceeds 16 KiB")))
            continue

        line = raw[:-1] if raw.endswith(b"\n") else raw
        if line.endswith(b"\r"):
            line = line[:-1]
        if len(line) > MAX_LINE_BYTES:
            _write_response(stdout, _error_response(None, RequestError("stdin line exceeds 16 KiB")))
            continue

        request_id: Any = None
        try:
            request = json.loads(line.decode("utf-8"))
            if isinstance(request, dict):
                request_id = request.get("id")
            response = worker.handle(request)
        except (UnicodeDecodeError, json.JSONDecodeError):
            response = _error_response(request_id, RequestError("invalid JSON request"))
        except Exception as error:
            response = _error_response(request_id, error)
        _write_response(stdout, response)


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Local persistent TTS worker")
    parser.add_argument("--root", required=True, type=Path, help="local models directory")
    parser.add_argument("--engine", required=True, choices=("kokoro", "habibi"))
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    worker = Worker(args.root, args.engine)
    serve(worker, sys.stdin.buffer, sys.stdout.buffer)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
