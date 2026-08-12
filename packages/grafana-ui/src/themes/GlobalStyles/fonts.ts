import { css } from '@emotion/react';

import { GrafanaTheme2 } from '@grafana/data';

export function getFontStyles(theme: GrafanaTheme2) {
  const grafanaPublicPath = typeof window !== 'undefined' && window.__grafana_public_path__;
  const fontRoot = grafanaPublicPath ? `${grafanaPublicPath}fonts/` : 'public/fonts/';

  return css([
    {
      /* latin */
      '@font-face': {
        fontFamily: 'Roboto Mono',
        fontStyle: 'normal',
        fontWeight: 400,
        fontDisplay: 'swap',
        src: `url('${fontRoot}roboto/L0xTDF4xlVMF-BfR8bXMIhJHg45mwgGEFl0_3vrtSM1J-gEPT5Ese6hmHSh0mQ.woff2') format('woff2')`,
        unicodeRange:
          'U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+2000-206F, U+2074, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD',
      },
    },
    {
      /* latin */
      '@font-face': {
        fontFamily: 'Roboto Mono',
        fontStyle: 'normal',
        fontWeight: 500,
        fontDisplay: 'swap',
        src: `url('${fontRoot}roboto/L0xTDF4xlVMF-BfR8bXMIhJHg45mwgGEFl0_3vrtSM1J-gEPT5Ese6hmHSh0mQ.woff2') format('woff2')`,
        unicodeRange:
          'U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+2000-206F, U+2074, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD',
      },
    },
    // NOTE: the bundled woff2 is actually a Cyrillic-only subset of Product
    // Sans *Thin Italic* (no Latin glyphs at all). Latin text has always
    // fallen through to the system sans-serif, while Cyrillic was hijacked by
    // this file and rendered thin italic. The unicode-range restricts the face
    // to Latin so both scripts consistently use the same fallback font.
    {
      '@font-face': {
        fontFamily: 'Product Sans',
        fontStyle: 'normal',
        fontWeight: 400,
        fontDisplay: 'swap',
        src: `url('${fontRoot}productSans/pxifypQkot1TnFhsFMOfGShVEu_vWEpkr1ap.woff2') format('woff2')`,
        unicodeRange: 'U+0000-00FF',
      },
    },
    {
      '@font-face': {
        fontFamily: 'Product Sans',
        fontStyle: 'normal',
        fontWeight: 500,
        fontDisplay: 'swap',
        src: `url('${fontRoot}productSans/pxifypQkot1TnFhsFMOfGShVEu_vWEpkr1ap.woff2') format('woff2')`,
        unicodeRange: 'U+0000-00FF',
      },
    },
  ]);
}
