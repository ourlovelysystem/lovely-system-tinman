# Tinman

Tinman is a voice-message application for Our Lovely System.

The current increment deliberately contains only the functional core:

- public self-identification
- browser microphone recording
- stop, replay, and ten-second seek controls
- direct upload to private S3 storage through a short-lived URL
- durable recording metadata in DynamoDB
- newest-first recording browser with playback
- `/appeals/` route tagging recordings as appeals

Rust, oiling, axes, animation, classification, transcription, response tracks, and accolades are outside this increment. They remain in Git history and can return only after the recording path works end to end.

## Deployment

```bash
cd backend
sam build
sam deploy
```

After deployment, place the `ApiUrl` output in `config.js`. Amplify will deploy the frontend from `main`.

## Acceptance test

1. Open `/appeals/`.
2. Enter a public self-identification.
3. Record, stop, replay, and seek the recording.
4. Submit it.
5. Refresh the page.
6. Find the recording in the browser and play it.
