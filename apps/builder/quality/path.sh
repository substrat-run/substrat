# path.sh — sourced by every harness script, which runs under plain `zsh`, never `zsh -i`.
#
# An interactive shell loads the profile, and the profile's hooks then run inside the script: a cd
# hook calling the `hash` builtin called a script's own `hash` function, which changed folder and
# ran the hook again, spawning the script without end (#3093). What the scripts wanted from the
# profile was node and pnpm on PATH; this gives them that and nothing else. Called from a shell
# that already has node, it changes nothing.
if (( ! $+commands[node] )); then
  nvm_bins=($HOME/.nvm/versions/node/v*/bin(N/nOn))  # the newest installed node first
  (( $#nvm_bins )) && path=($nvm_bins[1] $path)
  unset nvm_bins
fi
[[ -d /opt/homebrew/bin && ${path[(Ie)/opt/homebrew/bin]} -eq 0 ]] && path=($path /opt/homebrew/bin)
(( $+commands[node] )) || { echo "${0:t}: node is not on PATH, and no nvm install was found" >&2; exit 2; }
