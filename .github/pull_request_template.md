## Summary

<!-- What & why, 1-3 sentences -->

## Linked issue

Closes #

## Type

<!-- Keep one. The PR title becomes the squash commit on main, so write it as a Conventional
     Commit, e.g. `feat(editor): add keyboard moves`. -->

- feat / fix / chore / docs / refactor / perf / test / ci / build

## How was this tested?

<!-- Commands run and what you observed: unit tests, E2E against the container, manual checks -->

## Checklist

- [ ] Branch is `feature|bug|chore|docs/<#>-slug`, not main
- [ ] CI passes (`build` and `e2e`)
- [ ] Linked with `Closes #`
- [ ] No model files committed (`.stl`, `.3mf`, `.step`, `.zip`, `.gcode`); test fixtures are generated in code
- [ ] Catalog entries (if any): link + facts only, no images or copied descriptions, no ids removed
- [ ] UI changes (if any): keyboard path works, nothing relies on colour alone, axe is clean
