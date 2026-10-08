/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import {
  teamsDarkTheme,
  teamsHighContrastTheme,
  teamsLightTheme,
} from '@fluentui/react-components';
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

import {
  generateAdaptiveDarkTheme,
  generateAdaptiveLightTheme,
} from '../themeGenerator';

import { defaultState, type ThemeState } from './ThemeState';

export const ThemeContext = createContext<ThemeState>(defaultState);

export const useThemeMutationObserver = (
  callback: (themeKind: string) => void
) => {
  const observer = useMemo(
    () =>
      new MutationObserver((mutations) => {
        mutations.forEach(function (mutation) {
          if (
            mutation.type === 'attributes' &&
            mutation.attributeName === 'data-vscode-theme-kind'
          ) {
            const newValue =
              (mutation.target as HTMLElement).getAttribute(
                'data-vscode-theme-kind'
              ) ?? 'vscode-light';
            callback(newValue);
          }
        });
      }),
    [callback]
  );

  useEffect(() => {
    const targetNode = document.body;
    observer.observe(targetNode, {
      attributes: true,
    });

    return () => observer.disconnect();
  }, [observer]);
};

export const useVSCodeTheme = () => {
  return document.body.getAttribute('data-vscode-theme-kind') ?? 'vscode-light';
};

export const getFluentUiTheme = (useAdaptive = false, themeKind: string) => {
  if (useAdaptive) {
    return themeKind === 'vscode-light'
      ? generateAdaptiveLightTheme()
      : themeKind === 'vscode-dark'
        ? generateAdaptiveDarkTheme()
        : themeKind === 'vscode-high-contrast'
          ? teamsHighContrastTheme
          : themeKind === 'vscode-high-contrast-light'
            ? teamsLightTheme
            : undefined;
  }
  return themeKind === 'vscode-light'
    ? teamsLightTheme
    : themeKind === 'vscode-dark'
      ? teamsDarkTheme
      : themeKind === 'vscode-high-contrast'
        ? teamsHighContrastTheme
        : themeKind === 'vscode-high-contrast-light'
          ? teamsLightTheme
          : undefined;
};

export function useThemeState() {
  return useContext(ThemeContext);
}

export const ThemeProvider = ThemeContext.Provider;

export const generateThemeContext = (
  useAdaptive = false,
  themeKind: string
) => {
  return {
    fluentUI: {
      theme: getFluentUiTheme(useAdaptive, themeKind),
      themeKind,
    },
    useAdaptive,
    themeKind,
  };
};

export const WithTheme = ({
  children,
  useAdaptive,
}: {
  children: ReactNode;
  useAdaptive: boolean;
}) => {
  const [state, setState] = useState(
    generateThemeContext(useAdaptive, useVSCodeTheme())
  );

  function setThemeKind(themeKind: string) {
    setState({
      ...state,
      ...generateThemeContext(useAdaptive, themeKind),
    });
  }

  useEffect(() => {
    setThemeKind(useVSCodeTheme());
  }, [useAdaptive]);

  useThemeMutationObserver((themeKind) => {
    setThemeKind(themeKind);
  });

  return <ThemeProvider value={state}>{children}</ThemeProvider>;
};
