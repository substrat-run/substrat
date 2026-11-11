#!/bin/zsh
# pack.sh <dir> — packs every public package of this built checkout into <dir>, and writes the pnpm
# overrides that install them. A generated project installs from npm, so without this a run never
# meets unreleased code:  BUILDER_EVAL_WORKSPACE="$(cat <dir>/overrides.yaml)" queue-par.sh …
source ${0:A:h}/path.sh  # node on PATH without the profile; see path.sh
OUT=${1:A}
mkdir -p $OUT
print "overrides:" > $OUT/overrides.yaml
for f in packages/*/package.json engines/*/package.json connectors/*/package.json; do
  [[ $(node -p "require('./$f').private===true") == true ]] && continue
  dir=${f:h}; name=$(node -p "require('./$f').name")
  tgz=$(cd $dir && pnpm pack --pack-destination $OUT 2>/dev/null | tail -1)
  print "  '$name': 'file:$tgz'" >> $OUT/overrides.yaml
done
wc -l < $OUT/overrides.yaml
