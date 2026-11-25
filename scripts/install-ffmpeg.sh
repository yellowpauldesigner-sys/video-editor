#!/bin/sh
# Puts ffmpeg and ffprobe where uberdesigner clips looks for them: ~/.uberdesigner/clips/bin. No password, nothing
# else on the computer changes, and removing that folder removes them.
#
# The files are the static builds published on GitHub by the ffmpeg-static project
# (https://github.com/eugeneware/ffmpeg-static, release b6.1.1), built from ffmpeg's own source.
# The person runs this themselves; Claude never runs it for them.
set -e

BIN="$HOME/.uberdesigner/clips/bin"
BASE="https://github.com/eugeneware/ffmpeg-static/releases/download/b6.1.1"

case "$(uname -s)-$(uname -m)" in
  Darwin-arm64) PLAT="darwin-arm64" ;;
  Darwin-x86_64) PLAT="darwin-x64" ;;
  Linux-x86_64) PLAT="linux-x64" ;;
  Linux-aarch64) PLAT="linux-arm64" ;;
  *) echo "There is no ready build for this system ($(uname -s) $(uname -m)). Install ffmpeg yourself: https://ffmpeg.org/download.html"; exit 1 ;;
esac

mkdir -p "$BIN"
for tool in ffmpeg ffprobe; do
  echo "Downloading $tool…"
  curl -fL --progress-bar -o "$BIN/$tool.part" "$BASE/$tool-$PLAT"
  chmod +x "$BIN/$tool.part"
  # macOS marks downloaded programs; this one was asked for by name, from the address above
  [ "$(uname -s)" = "Darwin" ] && xattr -d com.apple.quarantine "$BIN/$tool.part" 2>/dev/null || true
  mv "$BIN/$tool.part" "$BIN/$tool"
done

if "$BIN/ffmpeg" -version >/dev/null 2>&1 && "$BIN/ffprobe" -version >/dev/null 2>&1; then
  echo "Done: $("$BIN/ffmpeg" -version | head -1)"
  echo "It is in $BIN"
else
  echo "The files downloaded but don't run. Install ffmpeg another way: https://ffmpeg.org/download.html"
  exit 1
fi
