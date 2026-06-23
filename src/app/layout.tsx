import type { Metadata } from 'next'
import Script from 'next/script'
import './globals.css'
import { bootstrap } from '@/bootstrap'
import { AppProviders } from '@/components/AppProviders'

// Bootstrap all package registrations at module load time
bootstrap()
import { detectLocale, loadDictionary } from '@open-mercato/shared/lib/i18n/server'

export const metadata: Metadata = {
  title: 'Open Mercato',
  description: 'AI-supportive, modular ERP foundation for product & service companies',
  icons: {
    icon: '/open-mercato.svg',
  },
}

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const locale = await detectLocale()
  const dict = await loadDictionary(locale)
  const demoModeEnabled = process.env.DEMO_MODE !== 'false'
  const noticeBarsEnabled = process.env.OM_INTEGRATION_TEST !== 'true'
  return (
    <html lang={locale} suppressHydrationWarning>
      <head>
        <Script id="om-theme-init" strategy="beforeInteractive" src="/theme-init.js" />
      </head>
      <body className="antialiased" suppressHydrationWarning data-gramm="false">
        <AppProviders locale={locale} dict={dict} demoModeEnabled={demoModeEnabled} noticeBarsEnabled={noticeBarsEnabled}>
          {children}
        </AppProviders>
      </body>
    </html>
  );
}
