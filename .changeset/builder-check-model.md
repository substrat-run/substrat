---
"@substrat-run/builder": minor
"@substrat-run/builder-generator": minor
"@substrat-run/builder-workspace": minor
---

The builder's model phase gets a `check_model` tool: the model gate's own compile and loader, every problem at once, while the model is still in its turn, so a declaration mistake is fixed in place instead of costing a repair turn. `pnpm builder evals` gains `--until model` (grade once the model-phase turn is done) and `--no-check-model` (the arm without the tool), and reports repairs by phase.
