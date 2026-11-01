# Building and releasing

## Scripts

| Script | What it does |
| --- | --- |
| `npm run dev` | Development build with HMR |
| `npm run build` | Production bundles in `out/` |
| `npm run clean` | Removes `out/` and the packaging artifacts in `dist/` |
| `npm start` | Run the production bundle |
| `npm run typecheck` | TypeScript for main, preload and renderer |
| `npm run verify` | Builds, then runs the Playwright end-to-end suite |
| `npm run verify:features` | Vault, connections, layers, notes, containers, locking |
| `npm run verify:profiles` | Shell detection unit checks (no Electron) |
| `npm run verify:sftp` | SSH host key + SFTP checks (needs `fixture:ssh` or your own server) |
| `npm run verify:sftp:unit` | known_hosts checks only – no Electron, no server |
| `npm run fixture:ssh` | Throwaway `sshd` in WSL on port 2222 for the SFTP checks |
| `npm run fixture:ssh:stop` | Stops that server |
| `npm run dist` | Packages for the current platform into `dist/` |
| `npm run dist:win` | Windows portable `.exe` + NSIS installer |
| `npm run dist:linux` | Linux AppImage + `tar.gz` |
| `npm run dist:docker` | Linux AppImage + `tar.gz`, built inside Docker (no host Node needed) |
| `npm run dist:portable` | Portable single-file `.exe` only |
| `npm run dist:installer` | NSIS installer only |

Every `dist*` script runs `npm run clean` first: electron-builder never empties its output
directory, so without it `dist/` keeps installers and unpacked folders from earlier versions. A
packaging run therefore only ever contains artifacts it just produced. (The Docker path does the
same from the other side: the compose service clears `./dist` before copying the image's output.)

`dist/TermTerm-data/` is exempt: the portable build relocates `userData` beside its executable, so
running `dist/TermTerm-<version>-portable.exe` stores that copy's layout and vault there. Cleaning
removes the old installers and unpacked app but never that folder. Close any TermTerm build running
from `dist/` before packaging – a locked executable stops the clean step with a message naming the
file, instead of being skipped silently.

> **Native modules:** `node-pty` 1.1 ships prebuilt N-API binaries for Windows and macOS, so **no C++
> toolchain is needed** there. `npmRebuild` is disabled in the electron-builder config for that
> reason. On Linux the package has no prebuild, so you need `build-essential`/`python3`.

`scripts/postinstall.cjs` runs after every install and repairs what npm 11 gates: Electron's binary
download and the `node-pty` compile. A fresh `npm ci` therefore always yields a runnable app.

## Portable or installer?

`npm run dist` produces both, so you can decide per audience:

| | `TermTerm-<version>-portable.exe` | `TermTerm-<version>-setup.exe` |
| --- | --- | --- |
| Install step | None – double-click and run | Wizard, optional install directory |
| Admin rights | Not required | Not required (per-user install) |
| Start Menu / uninstall entry | No | Yes |
| Move between machines (USB, OneDrive) | **Yes** – copy the one file | Reinstall |
| Settings location | `TermTerm-data\` **next to the exe** | `%APPDATA%\TermTerm` |
| Auto-update | Not wired up | Natural fit later |

The portable build is genuinely self-contained: when the launcher sets `PORTABLE_EXECUTABLE_DIR`,
the main process relocates `userData` to `TermTerm-data\` beside the executable, so your canvas
layout and `profiles.json` travel with it.

## Building the Linux release with Docker

You only need Docker – the image pins Node 24 plus the toolchain that `node-pty` needs on Linux:

```bash
docker compose run --rm --build package   # or: npm run dist:docker
ls dist
# TermTerm-0.2.0-linux-x86_64.AppImage
# TermTerm-0.2.0-linux-x64.tar.gz
```

What the build does: installs `build-essential`/`python3`, runs `npm ci` (which triggers the
postinstall repair above), builds the bundles, runs `electron-builder --linux`, and the compose
service copies `dist/` out to `./dist`. Host `node_modules` is never copied in (see
`.dockerignore`), so Windows-built binaries cannot leak into the Linux build.

| Detail | Why |
| --- | --- |
| Targets are AppImage + `tar.gz` | Both `dist:linux` and the Docker build read the same `build` block in `package.json` |
| Windows installers are not built here | NSIS/portable need Wine; they stay on the `windows-latest` runner |
| `DOCKER_UID` / `DOCKER_GID` | On Linux hosts, export `id -u`/`id -g` so `./dist` is not root-owned |
| Dependency layer is cached | The first build downloads Electron and compiles `node-pty` (~2–3 min); later edits only re-bundle and re-package |
| Command override | `docker compose run --rm --build package npx electron-builder --linux --dir` skips the copy step for quick unpacked builds |

The resulting tarball was checked in a clean Debian image: it unpacks with
`resources/app.asar.unpacked/node_modules/node-pty/build/Release/pty.node`, and the packaged
Electron runtime spawns a real PTY (`ELECTRON_RUN_AS_NODE=1 ./termterm …` prints `pty-works`).

## Releasing on GitHub

Two workflows are included; neither needs any secrets.

| Workflow | Trigger | What it does |
| --- | --- | --- |
| `CI` | push to `main`, pull requests | `npm ci`, typecheck, bundle, known_hosts checks |
| `Release` | push a `v*` tag (or manual dispatch) | Builds on **Windows and Ubuntu** runners in parallel, smoke-tests the PTY, packages, and attaches everything to a GitHub Release |

First push:

```powershell
git remote add origin https://github.com/<you>/TermTerm.git
git push -u origin main
```

Cut a release:

```powershell
git tag v0.1.0
git push origin v0.1.0
```

The release job publishes these assets (with auto-generated notes):

```
TermTerm-0.1.0-portable.exe     portable Windows single file
TermTerm-0.1.0-setup.exe        Windows installer
TermTerm-0.1.0-linux-x86_64.AppImage
TermTerm-0.1.0-linux-x64.tar.gz
```

Manual runs: **Actions → Release → Run workflow**, supply an existing tag, and optionally tick
*draft*.

Why the workflow does more than `npm run dist`:

- **Linux builds are not prebuilt.** `node-pty` ships binaries only for win32/darwin, so the workflow
  compiles it on the Ubuntu runner – and `scripts/postinstall.cjs` guarantees that even though npm 11
  gates dependency lifecycle scripts.
- **A PTY smoke test gates packaging.** `scripts/pty-smoke.cjs` spawns a real shell *inside Electron*
  (under `xvfb` on Linux) and fails the job if the native module cannot load, so a broken binary
  never reaches a release.
- **No source rebuild on Windows.** `npmRebuild` is off because the shipped prebuild is N-API and
  ABI-stable.
- **Electron downloads are cached** between runs to keep jobs quick.

> Debian/`.deb` packaging is a two-line addition to `build.linux.target`, but it needs a maintainer
> email in `package.json`; AppImage and `tar.gz` were chosen so CI stays free of personal details.

macOS targets need a signing identity before they are worth wiring up
([Roadmap](roadmap.md)).
