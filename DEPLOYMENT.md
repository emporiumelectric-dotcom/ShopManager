# ShopManager deployment

## Publishing model

GitHub Pages publishes only through the Actions workflows. Auto-deploy on push is off.

- Deploy current `main`: manually dispatch `.github/workflows/deploy-pages.yml`.
- Roll back: manually dispatch `.github/workflows/rollback-pages.yml` with a `commit_sha`.
- A push or merge by itself does not update the live site.
- Pages artifacts are retained for 30 days as deployment evidence. Artifact IDs are not rollback handles.

The production-verified rollback handle is the git tag `prod-stable` — pass `prod-stable` as `commit_sha` to the rollback workflow (it resolves to a commit like any ref).

After each deployment completes its installed-PWA verification gate, move the tag to the new commit and push it:

```bash
git tag -f prod-stable <verified-commit-sha>
git push origin prod-stable --force
```

## Rollback behavior

The rollback workflow checks out the requested commit, verifies that it is an ancestor of `main`, runs the same build and validation steps as a normal deployment, uploads a new Pages artifact, and deploys it.

`config.json` is regenerated from the repository secrets that exist at rollback time. This is safe for ordinary code rollback, but **commit-SHA rollback is unsafe during a key rotation between the secret change and full production verification**. Every future key-rotation change must define and rehearse its own rollback plan before changing the secret.

## Configuration exposure

The generated `config.json` is intentionally public because the browser needs the Supabase anon credential. The deployment plumbing makes the credential rotation-ready; it does not make the credential secret or reduce its exposure. Authorization continues to depend on server-side controls, including RLS and the existing `shop-write` Edge Function path.
