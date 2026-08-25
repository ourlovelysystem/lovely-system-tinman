# Tinman backend

The backend maintains Tinman's rust state and public maintenance log.

- `GET /state` returns rust points from 0–20.
- `POST /oil` removes exactly one rust point and records the public self-identification and target.
- `GET /maintenance` returns the newest public maintenance events.
- EventBridge adds a random 0–3 rust points once daily, capped at 20.

Deploy from this directory:

```sh
sam build
sam deploy --guided
```

Copy the `ApiUrl` output into `../config.js`. The page has an explicitly labeled browser-local fallback when no API URL is configured; the AWS backend is authoritative after configuration.
