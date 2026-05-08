Steps to build and install a development client for `waiter-app` (dev-client):

1. Install EAS CLI (requires an Expo account):

```bash
npm install -g eas-cli
```

2. Install native dev client package (already added to `package.json`):

```bash
cd waiter-app
npm install
```

3. Configure EAS for the project (run once):

```bash
cd waiter-app
eas login
eas build:configure
```

4. Build a development client (Android example):

```bash
# Development profile produces an installable dev client apk
eas build --platform android --profile development
```

5. Install the generated APK on your Android device (or follow TestFlight for iOS).

Notes:

- iOS builds require an Apple developer account and provisioning.
- After installing the dev-client, run the project with `expo start --dev-client` or use the QR returned by `eas build`.
- If you prefer not to use EAS, you can downgrade the Expo SDK to match device Expo Go, but that may require code changes.
