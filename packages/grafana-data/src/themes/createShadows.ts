/** @beta */
export interface ThemeShadows {
  z1: string;
  z2: string;
  z3: string;
}

/** @alpha */
export function createShadows(): ThemeShadows {
  return {
    z1: '0px 1px 2px rgba(1, 4, 9, 0.75)',
    z2: '0px 4px 8px rgba(1, 4, 9, 0.75)',
    z3: '0px 8px 24px rgb(1, 4, 9)',
  };
}
