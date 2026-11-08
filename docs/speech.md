# Read aloud (speech)

Read aloud makes the computer speak the teacher's words out loud. You press the speak control in the chat, and the app says the answer with a voice. You do not need an API key, and you do not need the internet after setup. Everything runs on your machine.

## Languages and voices

The language list has five choices:

- **English** (`English`)
- **French** (`Français`)
- **Italian** (`Italiano`)
- **Chinese** (`中文`)
- **Arabic** (`العربية`)

English, French, and Italian use the **Kokoro** model. Chinese uses **kokoro-zh**, a Kokoro model for Chinese. Kokoro is open source under the Apache-2.0 license. It runs on a normal computer CPU.

Arabic uses the **Habibi** model. Habibi covers many Arabic dialects, not just one. There are two things to know about it:

- The model weights use the **CC-BY-NC-SA-4.0** license. This means personal use only, not commercial use.
- The reference audio used to guide the voice comes from the Habibi benchmark, which is Apache-2.0 licensed.

## Install a voice

Go to **Settings → Speech**. You will see a list of models. Each row has a **Download** button. Press it and a progress bar shows how the download is going. When the model is in place, the row shows **Ready**. You can delete a model with its **Remove** button to free disk space.

Model sizes are about 310 MB for Kokoro in total and about 1.4 GB for Habibi.

## Arabic: GPU or CPU

Habibi can run on a GPU or a CPU. The device choices are **Automatic**, **CPU**, and **GPU**.

- **Automatic** only picks the GPU when it detects working NVIDIA CUDA support; otherwise it uses the CPU. You do not have to guess.
- **CPU** works on any machine, but it is slower.
- If you pick **GPU** on a machine without NVIDIA CUDA, the app tells you clearly and does not pretend it worked.

## Dictation and speech

If you use dictation (you speak and the app types), it stops the current speech first. The app will not read aloud while it listens to you.
