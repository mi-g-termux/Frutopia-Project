# Installer Fix Notes

The installer was not reliably showing because Firebase credentials were still baked into `.env`, and placeholder/non-real configs such as `your-project-id` were being treated as valid Firebase config.

Fixed in this ZIP:

- `.env` and `.env.example` Firebase values are blank for first-run setup.
- `public/firebase-config.json` is present but intentionally empty, so the app shows `/install`.
- Placeholder values like `your-project-id` and `your-firebase-api-key` are ignored instead of booting Firebase.
- Installer-entered credentials now take priority over `.env` values during setup.
- `/install?reset=1` clears browser install cache, Firebase browser config, and selected database engine.
- If the server cannot auto-write `firebase-config.json`, the wizard downloads it and also saves a browser fallback so local testing can continue.

To reinstall fresh on any site:

1. Upload/build this project.
2. Visit `/install?reset=1` once.
3. Enter real Firebase Web App credentials from Firebase Console.
4. The wizard will write/download `firebase-config.json`.
5. Put that file in `public/firebase-config.json` before building, or in the deployed website root after deployment.
