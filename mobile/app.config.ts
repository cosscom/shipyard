import type { ExpoConfig } from "expo/config";

// Shipyard for iPhone (Android later, from the same code). The phone talks
// to boxes over the tailnet, on each box's phone API (internal/box/phone.go,
// phonev2.go), and gets notifications through the push relay (push/).

const config: ExpoConfig = {
  name: "Shipyard",
  slug: "shipyard",
  // berth://pair#… pairs, like the desktop app's QR code.
  scheme: "berth",
  version: "0.1.0",
  orientation: "portrait",
  icon: "./assets/icon.png",
  userInterfaceStyle: "automatic",
  backgroundColor: "#16181b",
  ios: {
    bundleIdentifier: "dev.berth.phone",
    supportsTablet: true,
    config: { usesNonExemptEncryption: false },
    infoPlist: {
      // Boxes answer plain HTTP inside the tailnet (WireGuard encrypts it):
      // by address (100.x, which App Transport Security leaves alone), by
      // short name (local networking), or by MagicDNS name (*.ts.net).
      // Nothing else may be plain HTTP: the push relay is HTTPS.
      NSAppTransportSecurity: {
        NSAllowsLocalNetworking: true,
        NSExceptionDomains: { "ts.net": { NSIncludesSubdomains: true, NSExceptionAllowsInsecureHTTPLoads: true } },
      },
    },
  },
  android: { package: "dev.berth.phone" },
  plugins: [
    "expo-router",
    "expo-secure-store",
    "expo-font",
    ["expo-splash-screen", { image: "./assets/splash-icon.png", imageWidth: 160, resizeMode: "contain", backgroundColor: "#16181b" }],
    ["expo-camera", { cameraPermission: "Scan the pairing code Shipyard shows in Settings → Phone.", microphonePermission: false, recordAudioAndroid: false }],
    ["expo-notifications", { enableBackgroundRemoteNotifications: false }],
  ],
  experiments: { typedRoutes: true, tsconfigPaths: true },
  extra: {
    // Where the app gets its push key (push/README.md).
    relay: process.env.BERTH_PUSH_RELAY ?? "https://push.berthd.app",
    // Which APNs service the build's tokens are for: development builds
    // are sandbox (eas.json sets it per profile).
    apnsEnv: process.env.BERTH_APNS_ENV === "production" ? "production" : "sandbox",
  },
};

export default config;
