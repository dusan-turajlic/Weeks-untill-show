import type { Metadata, Viewport } from "next";
import "./globals.css";
import ServiceWorkerRegister from "@/components/ServiceWorkerRegister";

export const metadata: Metadata = {
  title: "Weight Projection",
  manifest: "/manifest.webmanifest",
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "Weight",
  },
  icons: {
    apple: "/apple-touch-icon.png",
    icon: [{ url: "/icon-192.png", type: "image/png", sizes: "192x192" }],
  },
};

export const viewport: Viewport = {
  themeColor: "#33533d",
  colorScheme: "light",
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    // suppressHydrationWarning: the app sets data-webgpu on <html> post-mount and
    // hydrates its state from URL/localStorage/IndexedDB (client only), so the
    // first client paint intentionally differs from the server markup.
    <html lang="en" suppressHydrationWarning>
      <head>
        {/* mobile-web-app-capable has no first-class Metadata field yet */}
        <meta name="mobile-web-app-capable" content="yes" />
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link
          rel="preconnect"
          href="https://fonts.gstatic.com"
          crossOrigin="anonymous"
        />
        <link
          href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,400;9..144,600;9..144,700&family=DM+Sans:wght@400;500;600&display=swap"
          rel="stylesheet"
        />
      </head>
      <body suppressHydrationWarning>
        {children}
        <ServiceWorkerRegister />
      </body>
    </html>
  );
}
