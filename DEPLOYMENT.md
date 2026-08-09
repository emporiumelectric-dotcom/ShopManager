# ShopManager deployment

## Publishing model

GitHub Pages publishes only through the Actions workflows. Auto-deploy on push is off.

- Deploy current `main`: manually dispatch `.github/workflows/deploy-pages.yml`.
- Roll back: manually dispatch `.github/workflows/rollback-pages.yml` with a `commit_sha`.
- A push or merge by itself does not update the live site.
- Pages artifacts are retained for 30 days as deployment evidence. Artifact IDs are not rollback handles.

The current production-verified rollback handle is:

```text
733ac9dbf8741687597685fa08be9b73ed2d10a2
```

Update this handle after each deployment completes its installed-PWA verification gate.

## Rollback behavior

The rollback workflow checks out the requested commit, verifies that it is an ancestor of `main`, runs the same build and validation steps as a normal deployment, uploads a new Pages artifact, and deploys it.

`config.json` is regenerated from the repository secrets that exist at rollback time. This is safe for ordinary code rollback, but **commit-SHA rollback is unsafe during a key rotation between the secret change and full production verification**. Every future key-rotation change must define and rehearse its own rollback plan before changing the secret.

## Configuration exposure

The generated `config.json` is intentionally public because the browser needs the Supabase anon credential. The deployment plumbing makes the credential rotation-ready; it does not make the credential secret or reduce its exposure. Authorization continues to depend on server-side controls, including RLS and the existing `shop-write` Edge Function path.
