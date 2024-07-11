import { merge } from 'lodash'

import { alpha, darken, emphasize, getContrastRatio, lighten } from './colorManipulator'
import { palette } from './palette'
import { DeepPartial, ThemeRichColor } from './types'

/** @internal */
export type ThemeColorsMode = 'light' | 'dark';

/** @internal */
export interface ThemeColorsBase<TColor> {
  mode: ThemeColorsMode;

  primary: TColor;
  secondary: TColor;
  info: TColor;
  error: TColor;
  success: TColor;
  warning: TColor;

  text: {
    accent1: string;
    primary: string;
    secondary: string;
    tertiary: string;
    quaternary: string;
    disabled: string;
    link: string;
    /** Used for auto white or dark text on colored backgrounds */
    maxContrast: string;
    active: string;
  };

  background: {
    /** Dashboard and body background */
    canvas: string;
    /** Primary content pane background (panels etc) */
    primary: string;
    constPrimary: string;
    /** Cards and elements that need to stand out on the primary background */
    secondary: string;
    surfacePrimary: string;
    buttonHovered: string;
    surfaceSecondary: string;
  };

  menu: {
    active: string;
    hovered: string;
    pressed: string;
    fontColor: string;
    selectedHovered: string;
    fontColorHovered: string;
  };

  border: {
    weak: string;
    medium: string;
    strong: string;
    secondary: string;
    teriary: string;
  };

  gradients: {
    brandVertical: string;
    brandHorizontal: string;
  };

  action: {
    /** Used for selected menu item / select option */
    selected: string;
    /**
     * @alpha (Do not use from plugins)
     * Used for selected items when background only change is not enough (Currently only used for FilterPill)
     **/
    selectedBorder: string;
    /** Used for hovered menu item / select option */
    hover: string;
    /** Used for button/colored background hover opacity */
    hoverOpacity: number;
    /** Used focused menu item / select option */
    focus: string;
    /** Used for disabled buttons and inputs */
    disabledBackground: string;
    /** Disabled text */
    disabledText: string;
    /** Disablerd opacity */
    disabledOpacity: number;
  };

  custom: {
    accentAccent1: string;
    hoverErrorButton: string;
  }

  hoverFactor: number;
  contrastThreshold: number;
  tonalOffset: number;
}

export interface ThemeHoverStrengh {}

/** @beta */
export interface ThemeColors extends ThemeColorsBase<ThemeRichColor> {
  /** Returns a text color for the background */
  getContrastText(background: string, threshold?: number): string;
  /* Brighten or darken a color by specified factor (0-1) */
  emphasize(color: string, amount?: number): string;
}

/** @internal */
export type ThemeColorsInput = DeepPartial<ThemeColorsBase<ThemeRichColor>>;

class DarkColors implements ThemeColorsBase<Partial<ThemeRichColor>> {
  mode: ThemeColorsMode = 'dark';

  // Used to get more white opacity colors
  whiteBase = '204, 204, 220';

  border = {
    weak: `rgba(${this.whiteBase}, 0.12)`,
    medium: `rgba(${this.whiteBase}, 0.20)`,
    strong: `rgba(${this.whiteBase}, 0.30)`,
    secondary: palette['border_secondary'],
    teriary: palette['border_teriary']
  };

  text = {
    accent1: palette['accent_accent-1'],
    primary: palette['text-icon_secondary'],
    secondary: palette['text-icon_secondary'],
    tertiary: palette['text-icon_tertiary'],
    quaternary: palette['text-icon_const-quaternary'],
    disabled: `rgba(${this.whiteBase}, 0.6)`,
    link: palette['accent_accent-1'],
    maxContrast: palette.white,
    active: palette['text-icon_const-primary']
  };

  primary = {
    main: palette.blueDarkMain,
    text: palette['accent_accent-1'],
    border: palette.blueDarkText,
  };

  secondary = {
    main: `rgba(${this.whiteBase}, 0.10)`,
    shade: `rgba(${this.whiteBase}, 0.14)`,
    transparent: `rgba(${this.whiteBase}, 0.08)`,
    text: this.text.primary,
    contrastText: `rgb(${this.whiteBase})`,
    border: `rgba(${this.whiteBase}, 0.08)`,
  };

  info = {
    main: palette.redDarkMain,
    text: palette['text-icon_secondary'],
  };

  error = {
    main: palette.redDarkMain,
    text: palette['accent_error'],
  };

  success = {
    main: palette.greenDarkMain,
    text: palette.greenDarkText,
  };

  warning = {
    main: palette.orangeDarkMain,
    text: palette.orangeDarkText,
  };

  background = {
    canvas: palette['background_secondary'],
    primary: palette['background_secondary'],
    constPrimary: palette['background_const-primary'],
    secondary: palette['surface_primary'],
    surfacePrimary: palette['surface_primary'],
    buttonHovered: palette['accent_accent-2'],
    surfaceSecondary: palette['surface_secondary']
  };

  menu = {
    active: palette['accent_accent-1'],
    hovered: palette['accent_accent-1'],
    selectedHovered: palette['accent_accent-1-hovered'],
    pressed: palette['accent_accent-1-pressed'],
    fontColor: palette['text-icon_const-quaternary'],
    fontColorHovered: palette['text-icon_const-primary'],
  };

  action = {
    hover: `rgba(${this.whiteBase}, 0.16)`,
    selected: `rgba(${this.whiteBase}, 0.12)`,
    selectedBorder: palette.orangeDarkMain,
    focus: `rgba(${this.whiteBase}, 0.16)`,
    hoverOpacity: 0.08,
    disabledText: this.text.disabled,
    disabledBackground: `rgba(${this.whiteBase}, 0.04)`,
    disabledOpacity: 0.38,
  };

  gradients = {
    brandHorizontal: 'linear-gradient(270deg, #F55F3E 0%, #FF8833 100%)',
    brandVertical: 'linear-gradient(0.01deg, #F55F3E 0.01%, #FF8833 99.99%)',
  };

  custom = {
    accentAccent1: palette['accent_accent-1'],
    hoverErrorButton: palette['accent_error-hovered']
  };

  contrastThreshold = 3;
  hoverFactor = 0.03;
  tonalOffset = 0.15;
}

class LightColors implements ThemeColorsBase<Partial<ThemeRichColor>> {
  mode: ThemeColorsMode = 'light';

  blackBase = '36, 41, 46';

  primary = {
    main: palette.blueLightMain,
    border: palette.blueLightText,
    text: palette.blueLightText,
  };

  text = {
    accent1: palette['accent_accent-1'],
    primary: palette['text-icon_secondary'],
    secondary: palette['text-icon_secondary'],
    tertiary: palette['text-icon_tertiary'],
    quaternary: palette['text-icon_const-quaternary'],
    disabled: `rgba(${this.blackBase}, 0.64)`,
    link: this.primary.text,
    maxContrast: palette.black,
    active: palette['text-icon_const-primary']
  };

  border = {
    weak: `rgba(${this.blackBase}, 0.12)`,
    medium: `rgba(${this.blackBase}, 0.30)`,
    strong: `rgba(${this.blackBase}, 0.40)`,
    secondary: palette['border_secondary'],
    teriary: palette['border_teriary']
  };

  secondary = {
    main: `rgba(${this.blackBase}, 0.08)`,
    shade: `rgba(${this.blackBase}, 0.15)`,
    transparent: `rgba(${this.blackBase}, 0.08)`,
    contrastText: `rgba(${this.blackBase},  1)`,
    text: this.text.primary,
    border: this.border.weak,
  };

  info = {
    main: palette.blueLightMain,
    text: palette.blueLightText,
  };

  error = {
    main: palette.redLightMain,
    text: palette['accent_error'],
    border: palette.redLightText,
  };

  success = {
    main: palette.greenLightMain,
    text: palette.greenLightText,
  };

  warning = {
    main: palette.orangeLightMain,
    text: palette.orangeLightText,
  };

  background = {
    canvas: palette.gray90,
    primary: palette.white,
    constPrimary: palette['background_const-primary'],
    secondary: palette.gray100,
    surfacePrimary: palette['surface_primary'],
    buttonHovered: palette['accent_accent-2'],
    surfaceSecondary: palette['surface_secondary']
  };

  menu = {
    active: palette['accent_accent-1'],
    hovered: palette['accent_accent-1'],
    selectedHovered: palette['accent_accent-1-hovered'],
    pressed: palette['accent_accent-1-pressed'],
    fontColor: palette['text-icon_const-quaternary'],
    fontColorHovered: palette['text-icon_const-primary'],
  };

  action = {
    hover: `rgba(${this.blackBase}, 0.12)`,
    selected: `rgba(${this.blackBase}, 0.08)`,
    selectedBorder: palette.orangeLightMain,
    hoverOpacity: 0.08,
    focus: `rgba(${this.blackBase}, 0.12)`,
    disabledBackground: `rgba(${this.blackBase}, 0.04)`,
    disabledText: this.text.disabled,
    disabledOpacity: 0.38,
  };

  gradients = {
    brandHorizontal: 'linear-gradient(90deg, #FF8833 0%, #F53E4C 100%)',
    brandVertical: 'linear-gradient(0.01deg, #F53E4C -31.2%, #FF8833 113.07%)',
  };

  custom = {
    accentAccent1: palette['accent_accent-1'],
    hoverErrorButton: palette['accent_error-hovered']
  };

  contrastThreshold = 3;
  hoverFactor = 0.03;
  tonalOffset = 0.2;
}

export function createColors(colors: ThemeColorsInput): ThemeColors {
  const dark = new DarkColors();
  const light = new LightColors();
  const base = (colors.mode ?? 'dark') === 'dark' ? dark : light;
  const {
    primary = base.primary,
    secondary = base.secondary,
    info = base.info,
    warning = base.warning,
    success = base.success,
    error = base.error,
    tonalOffset = base.tonalOffset,
    hoverFactor = base.hoverFactor,
    contrastThreshold = base.contrastThreshold,
    ...other
  } = colors;

  function getContrastText(background: string, threshold: number = contrastThreshold) {
    // todo, need color framework
    return getContrastRatio(dark.text.maxContrast, background, base.background.primary) >= threshold
      ? dark.text.maxContrast
      : light.text.maxContrast;
  }

  const getRichColor = ({ color, name }: GetRichColorProps): ThemeRichColor => {
    color = { ...color, name };
    if (!color.main) {
      throw new Error(`Missing main color for ${name}`);
    }
    if (!color.text) {
      color.text = color.main;
    }
    if (!color.border) {
      color.border = color.text;
    }
    if (!color.shade) {
      color.shade = base.mode === 'light' ? darken(color.main, tonalOffset) : lighten(color.main, tonalOffset);
    }
    if (!color.transparent) {
      color.transparent = alpha(color.main, 0.15);
    }
    if (!color.contrastText) {
      color.contrastText = getContrastText(color.main);
    }
    if (!color.borderTransparent) {
      color.borderTransparent = alpha(color.border, 0.25);
    }
    return color as ThemeRichColor;
  };

  return merge(
    {
      ...base,
      primary: getRichColor({ color: primary, name: 'primary' }),
      secondary: getRichColor({ color: secondary, name: 'secondary' }),
      info: getRichColor({ color: info, name: 'info' }),
      error: getRichColor({ color: error, name: 'error' }),
      success: getRichColor({ color: success, name: 'success' }),
      warning: getRichColor({ color: warning, name: 'warning' }),
      getContrastText,
      emphasize: (color: string, factor?: number) => {
        return emphasize(color, factor ?? hoverFactor);
      },
    },
    other
  );
}

interface GetRichColorProps {
  color: Partial<ThemeRichColor>;
  name: string;
}
