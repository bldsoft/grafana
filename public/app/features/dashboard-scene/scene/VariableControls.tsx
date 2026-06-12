import { css, cx } from '@emotion/css';

import { VariableHide, GrafanaTheme2 } from '@grafana/data';
import { selectors } from '@grafana/e2e-selectors';
import { config } from '@grafana/runtime';
import {
  sceneGraph,
  useSceneObjectState,
  SceneVariable,
  SceneVariableState,
  ControlsLabel,
  ControlsLayout,
  sceneUtils,
} from '@grafana/scenes';
import { useElementSelection, useStyles2 } from '@grafana/ui';

import { DashboardScene } from './DashboardScene';
import { AddVariableButton } from './VariableControlsAddButton';

export function VariableControls({ dashboard }: { dashboard: DashboardScene }) {
  const { variables } = sceneGraph.getVariables(dashboard)!.useState();
  const { isEditing } = dashboard.useState();
  const isEditingNewLayouts = isEditing && config.featureToggles.dashboardNewLayouts;

  // Get visible variables for drilldown layout
  const visibleVariables = variables.filter((v) => v.state.hide !== VariableHide.inControlsMenu);

  const adHocVar = visibleVariables.find((v) => sceneUtils.isAdHocVariable(v));
  const groupByVar = visibleVariables.find((v) => sceneUtils.isGroupByVariable(v));

  const hasDrilldownControls = config.featureToggles.dashboardAdHocAndGroupByWrapper && adHocVar && groupByVar;

  const restVariables = visibleVariables.filter(
    (v) => v.state.name !== adHocVar?.state.name && v.state.name !== groupByVar?.state.name
  );

  //  Variables to render (exclude adhoc/groupby when drilldown controls are shown in top row)
  // Only filter out inControlsMenu - VariableValueSelectWrapper handles rendering logic:
  // - UNSAFE_renderAsHidden variables render invisibly (for ScopesVariable)
  // - Regular hidden variables render greyed out in edit mode, or not at all otherwise
  const variablesToRender = hasDrilldownControls
    ? restVariables.filter((v) => v.state.hide !== VariableHide.inControlsMenu)
    : variables.filter((v) => v.state.hide !== VariableHide.inControlsMenu);

  return (
    <>
      {variablesToRender.length > 0 &&
        variablesToRender.map((variable) => (
          <VariableValueSelectWrapper
            key={variable.state.key}
            variable={variable}
            isEditingNewLayouts={isEditingNewLayouts}
          />
        ))}

      {config.featureToggles.dashboardNewLayouts ? <AddVariableButton dashboard={dashboard} /> : null}
    </>
  );
}

interface VariableSelectProps {
  variable: SceneVariable;
  inMenu?: boolean;
  isEditingNewLayouts?: boolean;
}

export function VariableValueSelectWrapper({ variable, inMenu, isEditingNewLayouts }: VariableSelectProps) {
  const state = useSceneObjectState<SceneVariableState>(variable, { shouldActivateOrKeepAlive: true });
  const { isSelected, onSelect, isSelectable } = useElementSelection(variable.state.key);
  const isHidden = state.hide === VariableHide.hideVariable;
  const shouldShowHiddenVariables = isEditingNewLayouts && isHidden;
  const styles = useStyles2(getStyles);

  // UNSAFE_renderAsHidden variables (like ScopesVariable) should always render invisibly
  if (isHidden && variable.UNSAFE_renderAsHidden) {
    return <variable.Component model={variable} />;
  }

  if (isHidden && !isEditingNewLayouts) {
    return null;
  }

  const onPointerDown = (evt: React.PointerEvent) => {
    if (!isSelectable) {
      return;
    }

    // Ignore click if it's inside the value control
    if (evt.target instanceof Element) {
      // multi variable options contain label element so we need a more specific
      //  condition to target variable label to prevent edit pane selection on option click
      const forAttribute = evt.target.closest('label[for]')?.getAttribute('for');

      if (!(forAttribute === `var-${variable.state.key || ''}`)) {
        // Prevent clearing selection when clicking inside value
        evt.stopPropagation();
        return;
      }
    }

    if (isSelectable && onSelect) {
      evt.stopPropagation();
      onSelect(evt);
    }
  };

  // For switch variables in menu, we want to show the switch on the left and the label on the right
  if (inMenu && sceneUtils.isSwitchVariable(variable)) {
    return (
      <div
        className={cx(
          styles.switchMenuContainer,
          shouldShowHiddenVariables && styles.hidden,
          isSelected && 'dashboard-selected-element',
          isSelectable && !isSelected && 'dashboard-selectable-element'
        )}
        onPointerDown={onPointerDown}
        data-testid={selectors.pages.Dashboard.SubMenu.submenuItem}
      >
        <div className={styles.switchControl}>
          <variable.Component model={variable} />
        </div>
        <VariableLabel
          variable={variable}
          layout={'vertical'}
          className={cx(isSelectable && styles.labelSelectable, styles.switchLabel)}
        />
      </div>
    );
  }

  if (inMenu) {
    return (
      <div
        className={cx(
          styles.verticalContainer,
          shouldShowHiddenVariables && styles.hidden,
          isSelected && 'dashboard-selected-element',
          isSelectable && !isSelected && 'dashboard-selectable-element'
        )}
        onPointerDown={onPointerDown}
        data-testid={selectors.pages.Dashboard.SubMenu.submenuItem}
      >
        <VariableLabel variable={variable} layout={'vertical'} className={cx(isSelectable && styles.labelSelectable)} />
        <variable.Component model={variable} />
      </div>
    );
  }

  return (
    <div
      className={cx(
        styles.container,
        shouldShowHiddenVariables && styles.hidden,
        isSelected && 'dashboard-selected-element',
        isSelectable && !isSelected && 'dashboard-selectable-element'
      )}
      onPointerDown={onPointerDown}
      data-testid={selectors.pages.Dashboard.SubMenu.submenuItem}
    >
      <VariableLabel variable={variable} className={cx(isSelectable && styles.labelSelectable, styles.label)} />
      <variable.Component model={variable} />
    </div>
  );
}

function VariableLabel({
  variable,
  className,
  layout,
}: {
  variable: SceneVariable;
  className?: string;
  layout?: ControlsLayout;
}) {
  const { state } = variable;

  if (variable.state.hide === VariableHide.hideLabel) {
    return null;
  }

  const labelOrName = state.label || state.name;
  const elementId = `var-${state.key}`;

  return (
    <ControlsLabel
      htmlFor={elementId}
      isLoading={state.loading}
      onCancel={() => variable.onCancel?.()}
      label={labelOrName}
      error={state.error}
      layout={layout ?? 'horizontal'}
      description={state.description ?? undefined}
      className={className}
    />
  );
}

const getStyles = (theme: GrafanaTheme2) => ({
  container: css({
    display: 'inline-flex',
    alignItems: 'center',
    verticalAlign: 'middle',
    marginBottom: theme.spacing(1),
    marginRight: theme.spacing(1),

    // Analytix: standard 32px control height - the global 44px input override is meant
    // for forms, not for the compact variable pickers (pre-12.x look)
    '[class*="input-wrapper"]': {
      height: theme.spacing(theme.components.height.md),
      minHeight: theme.spacing(theme.components.height.md),
    },

    // Analytix: compact variable picker - selected values render as plain text
    // joined with "+" instead of removable pills, no clear-all icon
    '[class*="grafana-select-multi-value-container"]': {
      backgroundColor: 'transparent',
      margin: 0,
      padding: 0,
      // the pill rounding + overflow:hidden clipped the text corners (e.g. "All")
      borderRadius: 'unset',
      overflow: 'visible',

      '& > div': {
        overflow: 'visible',
        textOverflow: 'clip',
      },
    },
    '[class*="grafana-select-multi-value-container"] + [class*="grafana-select-multi-value-container"]::before': {
      content: '"+"',
      margin: theme.spacing(0, 0.5),
      color: theme.colors.text.primary,
    },
    '[class*="grafana-select-multi-value-remove"]': {
      display: 'none',
    },
    'svg[role="button"]': {
      display: 'none',
    },
  }),
  verticalContainer: css({
    display: 'flex',
    flexDirection: 'column',
    padding: theme.spacing(1),
  }),
  switchMenuContainer: css({
    display: 'flex',
    alignItems: 'center',
    gap: theme.spacing(1),
    padding: theme.spacing(1),
  }),
  switchControl: css({
    '& > div': {
      border: 'none',
      background: 'transparent',
      paddingRight: theme.spacing(0.5),
      height: theme.spacing(2),
    },
  }),
  switchLabel: css({
    marginTop: 0,
    marginBottom: 0,
  }),
  labelSelectable: css({
    cursor: 'pointer',
  }),
  label: css({
    display: 'flex',
    alignItems: 'center',

    // Analytix: label is plain accent-colored text without the boxed background
    '&&': {
      background: 'transparent',
      border: 'none',
      color: theme.colors.text.accent1,
      paddingLeft: 0,

      svg: {
        display: 'none',
      },
    },
  }),
  hidden: css({
    opacity: 0.6,
    '&:hover': css({
      opacity: 1,
    }),
    label: css({
      textDecoration: 'line-through',
    }),
  }),
});
