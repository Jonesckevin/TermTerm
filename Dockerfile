# syntax=docker/dockerfile:1
#
# Builds TermTerm's Linux artifacts inside a pinned Node image, so the host needs
# only Docker – no Node, Electron, or C++ toolchain.
#
#   docker compose run --rm --build package
#
# Windows installers stay on the windows-latest runner in
# .github/workflows/release.yml, because electron-builder needs Wine to produce
# NSIS/portable executables and that path is not worth containerising.
ARG NODE_VERSION=24

FROM node:${NODE_VERSION}-bookworm AS base
ENV DEBIAN_FRONTEND=noninteractive
# node-pty has no Linux prebuild, so it is compiled here; git is used by some
# electron-builder code paths when it inspects the repository.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        build-essential \
        python3 \
        git \
        ca-certificates \
    && rm -rf /var/lib/apt/lists/*

FROM base AS deps
WORKDIR /app
# Only the manifests first, so dependency installation is cached independently
# of source edits. The root postinstall repairs what npm 11 skips: the Electron
# binary download and the node-pty compile.
COPY package.json package-lock.json ./
COPY scripts/postinstall.cjs scripts/postinstall.cjs
RUN npm ci

FROM deps AS builder
COPY . .
RUN npm run build

FROM builder AS release
# AppImage + tar.gz, exactly what `npm run dist:linux` produces locally.
RUN npx electron-builder --linux
RUN ls -lh dist
