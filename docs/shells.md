# Shells

TermTerm detects shells itself – there is nothing to configure for a normal setup. The palette
(<kbd>Ctrl</kbd>+<kbd>T</kbd>) lists everything it found with a badge, a path and a kind.

| Profile | How it is found |
| --- | --- |
| PowerShell 7 | `pwsh.exe` on `PATH`, `%ProgramFiles%\PowerShell\7`, the WindowsApps alias, or Scoop |
| PowerShell 7 Preview | `pwsh-preview.exe`, `%ProgramFiles%\PowerShell\7-preview`, Scoop |
| Windows PowerShell 5.1 | `%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe` |
| Command Prompt | `%ComSpec%` / `System32\cmd.exe` |
| Git Bash | `%ProgramFiles%`, `%ProgramFiles(x86)%`, `%LOCALAPPDATA%\Programs\Git`, Scoop (`bash --login -i`) |
| MSYS2 Bash | `C:\msys64\{usr,ucrt64,mingw64}\bin\bash.exe`, Scoop (`--login -i`) |
| Cygwin Bash | `C:\cygwin64\bin` or `C:\cygwin\bin` (`--login -i`) |
| Nushell | `nu.exe` on `PATH`, `%ProgramFiles%\Nu\bin`, WindowsApps, Scoop, `~\.cargo\bin` |
| WSL distros | Every distro from `wsl --list --quiet`, one profile each, started with `wsl -d <distro> --cd ~` |
| Containers | Every running container from `docker ps` / `podman ps`, started with `<engine> exec -it <name> sh` |
| SSH hosts | Every literal `Host` entry in `~/.ssh/config` (including `Include`d files), started with `ssh -t <host>`; the picker shows `user@host:port · key` |
| zsh / bash / fish / nu | macOS and Linux, plus anything listed in `/etc/shells` (`sh`, `dash`, `ksh`, `tmux`, …) |

The POSIX side reads `/etc/shells` rather than a hard-coded list, so any shell the system accepts
shows up – and the shell in `$SHELL` is tagged **default** in the picker.

Distro styling is built in for Ubuntu, Kali, Debian, Fedora, Arch, Alpine, openSUSE and Docker
Desktop; anything else gets a monogram derived from its name.

## Details worth knowing

- **No guessing from `PATH` for bash on Windows.** `where bash.exe` resolves to
  `System32\bash.exe` on machines without Git – that is the WSL launcher, not Git Bash – so it is
  deliberately never used for that profile.
- **SSH user/port/key** come from your config for display only; the session still runs plain
  `ssh -t <host>` so ssh applies the full config (including options we do not parse).
- **Container nodes are live, not saved.** They are discovered from the engine each time the
  palette opens, so nothing about a container is written to `layout.json` or the vault, and a node
  whose container has stopped simply exits. Images without `/bin/sh` (some distroless ones) need a
  custom profile instead.
- **Adding Kali:** `wsl --install -d kali-linux` (or the Microsoft Store) – it appears as a
  *Kali Linux (WSL)* profile on the next launch. Kali in a VM works too: add it to
  `~/.ssh/config` and it shows up as an SSH profile, or save it as a connection
  ([Connections](connections.md)).

## Custom shells

Anything not auto-detected can be declared in `profiles.json` next to the layout file
(`%APPDATA%\TermTerm\profiles.json`, or `TermTerm-data\` for the portable build):

```json
[
  {
    "name": "My Dev Box",
    "command": "ssh",
    "args": ["-t", "-p", "2222", "dev@10.0.0.5"],
    "cwd": "C:\\work",
    "badge": "DB",
    "accent": "#22c55e"
  }
]
```

Entries are spawned with an argv array – nothing goes through a shell – so quoting works exactly
as it does in `argv`.
