/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import {
  Badge,
  Body1,
  Button,
  Checkbox,
  Combobox,
  Divider,
  Dropdown,
  Input,
  Label,
  MessageBar,
  MessageBarBody,
  MessageBarTitle,
  Option,
  ProgressBar,
  Radio,
  RadioGroup,
  Spinner,
  Subtitle1,
  Switch,
  Tab,
  TabList,
  Textarea,
  Toolbar,
  ToolbarButton,
} from '@fluentui/react-components';
import {
  AddRegular,
  ArrowDownloadRegular,
  DeleteRegular,
  EditRegular,
  PlayRegular,
  SaveRegular,
  SearchRegular,
  SettingsRegular,
  StopRegular,
} from '@fluentui/react-icons';
import * as l10n from '@vscode/l10n';
import { useState } from 'react';

export const ThemeTab: React.FC = () => {
  const [themeSubTab, setThemeSubTab] = useState<string>('buttons');
  const [dropdownValue, setDropdownValue] = useState<string>('Option A');

  return (
    <div className="mainView__tab-panel">
      <div className="mainView__card">
        <div className="mainView__card-header">
          <Subtitle1>{l10n.t('Theme Showcase')}</Subtitle1>
          <Badge appearance="tint" color="informative">
            {l10n.t('Theming')}
          </Badge>
        </div>
        <Body1>
          {l10n.t(
            'These Fluent UI components automatically adapt when you switch VS Code themes (Ctrl+K Ctrl+T). The DynamicThemeProvider observes theme changes and regenerates Fluent tokens from VS Code CSS variables.'
          )}
        </Body1>

        <TabList
          selectedValue={themeSubTab}
          onTabSelect={(_, data) => setThemeSubTab(data.value as string)}
        >
          <Tab value="buttons">{l10n.t('Buttons')}</Tab>
          <Tab value="feedback">{l10n.t('Feedback')}</Tab>
          <Tab value="inputs">{l10n.t('Inputs')}</Tab>
        </TabList>

        <div className="mainView__card-content">
          {/* ─── Buttons sub-tab ──────── */}
          {themeSubTab === 'buttons' && (
            <div className="mainView__theme-grid">
              <div className="mainView__theme-swatch">
                <Body1>{l10n.t('Primary')}</Body1>
                <Button appearance="primary" icon={<SaveRegular />}>
                  {l10n.t('Save')}
                </Button>
              </div>
              <div className="mainView__theme-swatch">
                <Body1>{l10n.t('Secondary')}</Body1>
                <Button appearance="secondary" icon={<EditRegular />}>
                  {l10n.t('Edit')}
                </Button>
              </div>
              <div className="mainView__theme-swatch">
                <Body1>{l10n.t('Subtle')}</Body1>
                <Button appearance="subtle" icon={<SearchRegular />}>
                  {l10n.t('Search')}
                </Button>
              </div>
              <div className="mainView__theme-swatch">
                <Body1>{l10n.t('Outline')}</Body1>
                <Button appearance="outline" icon={<SettingsRegular />}>
                  {l10n.t('Settings')}
                </Button>
              </div>
              <div className="mainView__theme-swatch">
                <Body1>{l10n.t('Toolbar')}</Body1>
                <Toolbar>
                  <ToolbarButton icon={<PlayRegular />}>
                    {l10n.t('Run')}
                  </ToolbarButton>
                  <ToolbarButton icon={<StopRegular />}>
                    {l10n.t('Stop')}
                  </ToolbarButton>
                </Toolbar>
              </div>
              <div className="mainView__theme-swatch">
                <Body1>{l10n.t('Icon Buttons')}</Body1>
                <div className="mainView__button-row">
                  <Button appearance="subtle" icon={<AddRegular />} />
                  <Button appearance="subtle" icon={<DeleteRegular />} />
                  <Button appearance="subtle" icon={<ArrowDownloadRegular />} />
                </div>
              </div>
            </div>
          )}

          {/* ─── Feedback sub-tab ─────── */}
          {themeSubTab === 'feedback' && (
            <div className="mainView__feedback-stack">
              <MessageBar intent="info">
                <MessageBarBody>
                  <MessageBarTitle>{l10n.t('Info')}</MessageBarTitle>
                  {l10n.t('This is an informational message.')}
                </MessageBarBody>
              </MessageBar>
              <MessageBar intent="success">
                <MessageBarBody>
                  <MessageBarTitle>{l10n.t('Success')}</MessageBarTitle>
                  {l10n.t('Operation completed successfully.')}
                </MessageBarBody>
              </MessageBar>
              <MessageBar intent="warning">
                <MessageBarBody>
                  <MessageBarTitle>{l10n.t('Warning')}</MessageBarTitle>
                  {l10n.t('Something might need your attention.')}
                </MessageBarBody>
              </MessageBar>
              <MessageBar intent="error">
                <MessageBarBody>
                  <MessageBarTitle>{l10n.t('Error')}</MessageBarTitle>
                  {l10n.t('An error occurred during the operation.')}
                </MessageBarBody>
              </MessageBar>
              <ProgressBar value={0.65} max={1} />
              <div className="mainView__button-row">
                <Badge appearance="filled" color="brand">
                  {l10n.t('Brand')}
                </Badge>
                <Badge appearance="filled" color="danger">
                  {l10n.t('Danger')}
                </Badge>
                <Badge appearance="filled" color="important">
                  {l10n.t('Important')}
                </Badge>
                <Badge appearance="filled" color="informative">
                  {l10n.t('Informative')}
                </Badge>
                <Badge appearance="filled" color="severe">
                  {l10n.t('Severe')}
                </Badge>
                <Badge appearance="filled" color="subtle">
                  {l10n.t('Subtle')}
                </Badge>
                <Badge appearance="filled" color="success">
                  {l10n.t('Success')}
                </Badge>
                <Badge appearance="filled" color="warning">
                  {l10n.t('Warning')}
                </Badge>
              </div>
            </div>
          )}

          {/* ─── Inputs sub-tab ──────── */}
          {themeSubTab === 'inputs' && (
            <div className="mainView__inputs-stack">
              <div className="mainView__input-row">
                <Label htmlFor="demo-input">{l10n.t('Input')}</Label>
                <Input
                  id="demo-input"
                  placeholder={l10n.t('Type something...')}
                />
              </div>
              <div className="mainView__input-row">
                <Label htmlFor="demo-textarea">{l10n.t('Textarea')}</Label>
                <Textarea
                  id="demo-textarea"
                  placeholder={l10n.t('Multi-line text...')}
                />
              </div>
              <div className="mainView__input-row">
                <Label htmlFor="demo-dropdown">{l10n.t('Dropdown')}</Label>
                <Dropdown
                  id="demo-dropdown"
                  value={dropdownValue}
                  onOptionSelect={(_, data) =>
                    setDropdownValue(data.optionText ?? dropdownValue)
                  }
                >
                  <Option>{l10n.t('Option A')}</Option>
                  <Option>{l10n.t('Option B')}</Option>
                  <Option>{l10n.t('Option C')}</Option>
                </Dropdown>
              </div>
              <div className="mainView__input-row">
                <Label>{l10n.t('Combobox')}</Label>
                <Combobox placeholder={l10n.t('Search options...')}>
                  <Option>{l10n.t('Apple')}</Option>
                  <Option>{l10n.t('Banana')}</Option>
                  <Option>{l10n.t('Cherry')}</Option>
                  <Option>{l10n.t('Dragon Fruit')}</Option>
                </Combobox>
              </div>
              <Divider className="mainView__divider" />
              <div className="mainView__input-row">
                <Checkbox label={l10n.t('Checkbox option')} />
              </div>
              <div className="mainView__input-row">
                <Switch label={l10n.t('Toggle switch')} />
              </div>
              <div className="mainView__input-row">
                <Label>{l10n.t('Radio Group')}</Label>
                <RadioGroup>
                  <Radio value="a" label={l10n.t('Option A')} />
                  <Radio value="b" label={l10n.t('Option B')} />
                  <Radio value="c" label={l10n.t('Option C')} />
                </RadioGroup>
              </div>
              <div className="mainView__input-row">
                <Body1>{l10n.t('Spinner')}</Body1>
                <Spinner size="medium" label={l10n.t('Loading...')} />
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
