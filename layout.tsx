import type { Metadata, Viewport } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'VYRO.CHAT — Meet. Match. Connect.',
  description: 'Meet people through shared interests. Real conversations, one match at a time.',
  applicationName: 'VYRO.CHAT',
};
export const viewport: Viewport = { themeColor: '#070913', width: 'device-width', initialScale: 1 };

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body>{children}</body></html>;
}
