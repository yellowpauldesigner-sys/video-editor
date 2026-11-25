#!/bin/sh
# What uberdesigner clips needs on this computer, checked in plain shell (so it runs before Node is there).
# It only looks; it never installs anything.
#
#   sh scripts/setup-check.sh            READY, or STEPS / NEXT / PERSON RUNS <command>
#   sh scripts/setup-check.sh --wait 600 the same, but waits (up to 600 s) for the step that was NEXT to be done
#
# Needed: Node.js 22+ and Google Chrome (the editor runs in it and builds the video there). Wanted for changes by
# Claude inside the editor: Claude Code, logged in. ffmpeg is not needed; only the scripted site recorder uses it
# (install-ffmpeg.sh), and this check says whether it is there.

HERE="$(cd "$(dirname "$0")" && pwd)"
OWN="$HOME/.uberdesigner/clips/bin"

find_node() {
  for n in node "$HOME/.local/bin/node" /opt/homebrew/bin/node /usr/local/bin/node; do
    if command -v "$n" >/dev/null 2>&1; then
      major="$("$n" -p 'process.versions.node.split(".")[0]' 2>/dev/null)"
      if [ -n "$major" ] && [ "$major" -ge 22 ] 2>/dev/null; then echo "$n"; return 0; fi
    fi
  done
  return 1
}
have_ffmpeg() {
  for d in "$OWN" ""; do
    if [ -n "$d" ]; then [ -x "$d/ffmpeg" ] && [ -x "$d/ffprobe" ] && return 0
    else command -v ffmpeg >/dev/null 2>&1 && command -v ffprobe >/dev/null 2>&1 && return 0; fi
  done
  for d in /opt/homebrew/bin /usr/local/bin; do [ -x "$d/ffmpeg" ] && [ -x "$d/ffprobe" ] && return 0; done
  return 1
}
have_chrome() {
  [ -n "$CHROME" ] && [ -x "$CHROME" ] && return 0
  case "$(uname -s)" in
    Darwin)
      for a in "/Applications/Google Chrome.app" "$HOME/Applications/Google Chrome.app" "/Applications/Chromium.app" "/Applications/Microsoft Edge.app" "/Applications/Brave Browser.app"; do [ -d "$a" ] && return 0; done
      return 1 ;;
    *) command -v google-chrome >/dev/null 2>&1 || command -v google-chrome-stable >/dev/null 2>&1 || command -v chromium >/dev/null 2>&1 || command -v chromium-browser >/dev/null 2>&1 ;;
  esac
}
find_claude() {
  for c in "$CLAUDE_BIN" "$HOME/.local/bin/claude" /opt/homebrew/bin/claude /usr/local/bin/claude claude; do
    [ -n "$c" ] && command -v "$c" >/dev/null 2>&1 && { echo "$c"; return 0; }
  done
  return 1
}
claude_in() {
  c="$(find_claude)" || return 1
  "$c" auth status >/dev/null 2>&1
}

steps() {
  s=""
  find_node >/dev/null || s="$s install-node"
  have_chrome || s="$s install-chrome"
  if ! find_claude >/dev/null; then s="$s install-claude log-in"
  elif ! claude_in; then s="$s log-in"; fi
  echo "$s" | sed 's/^ //'
}

report() {
  s="$(steps)"
  if [ -z "$s" ]; then
    echo "READY"
    echo "NODE $(find_node)"
    have_ffmpeg && echo "FFMPEG yes" || echo "FFMPEG no (only the scripted site recorder needs it)"
    return 0
  fi
  next="${s%% *}"
  echo "STEPS $s"
  echo "NEXT $next"
  case "$next" in
    install-node) echo "PERSON OPENS https://nodejs.org/en/download (the LTS installer)" ;;
    install-chrome) echo "PERSON OPENS https://www.google.com/chrome/" ;;
    install-claude) echo "PERSON RUNS curl -fsSL https://claude.ai/install.sh | bash" ;;
    log-in) echo "PERSON RUNS claude auth login" ;;
  esac
  # Claude Code is only for changes made by Claude inside the editor: everything else works without it
  case "$next" in install-claude|log-in) echo "OPTIONAL the editor and building the video work without this step; changes by Claude in the editor wait for it" ;; esac
  return 1
}

if [ "$1" = "--wait" ]; then
  limit="${2:-600}"
  was="$(steps)"
  first="${was%% *}"
  waited=0
  while [ "$waited" -lt "$limit" ]; do
    now="$(steps)"
    case " $now " in *" $first "*) ;; *) break ;; esac
    sleep 3
    waited=$((waited + 3))
  done
fi
report
