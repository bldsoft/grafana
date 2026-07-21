import { render, screen } from '@testing-library/react';
import { TestProvider } from 'test/helpers/TestProvider';

import { OrgRole } from '@grafana/data';
import { ContextSrv, setContextSrv } from 'app/core/services/context_srv';
import { getUserOrganizations } from 'app/features/org/state/actions';
import { StoreState } from 'app/types/store';

import { OrganizationSwitcher } from './OrganizationSwitcher';

jest.mock('app/features/org/state/actions', () => ({
  ...jest.requireActual('app/features/org/state/actions'),
  getUserOrganizations: jest.fn(),
  setUserOrganization: jest.fn(),
}));

jest.mock('app/types/store', () => ({
  ...jest.requireActual('app/types/store'),
  useDispatch: () => jest.fn(),
}));

const renderWithProvider = ({ initialState }: { initialState?: Partial<StoreState> }) => {
  render(
    <TestProvider storeState={initialState}>
      <OrganizationSwitcher />
    </TestProvider>
  );
};

describe('OrganisationSwitcher', () => {
  beforeEach(() => {
    jest.spyOn(window, 'matchMedia').mockImplementation(
      () =>
        ({
          addEventListener: jest.fn(),
          removeEventListener: jest.fn(),
          matches: true,
        }) as unknown as MediaQueryList
    );
  });

  it('should only render if more than one organisations', () => {
    renderWithProvider({
      initialState: {
        organization: {
          organization: { name: 'test', id: 1 },
          userOrgs: [
            { orgId: 1, name: 'test', role: OrgRole.Admin },
            { orgId: 2, name: 'test2', role: OrgRole.Admin },
          ],
        },
      },
    });

    expect(screen.getByRole('combobox', { name: 'Change organization' })).toBeInTheDocument();
  });

  it('should not render if there is only one organisation', () => {
    renderWithProvider({
      initialState: {
        organization: {
          organization: { name: 'test', id: 1 },
          userOrgs: [{ orgId: 1, name: 'test', role: OrgRole.Admin }],
        },
      },
    });

    expect(screen.queryByRole('combobox', { name: 'Change organization' })).not.toBeInTheDocument();
  });

  // Analytix: with a single organization there is no switcher, so the slot
  // names the organization instead of showing the product name.
  it('should render the organization name when there is only one organisation', () => {
    const contextSrv = new ContextSrv();
    contextSrv.user.orgName = 'Setplex R&D';
    setContextSrv(contextSrv);

    renderWithProvider({
      initialState: {
        organization: {
          organization: { name: 'Setplex R&D', id: 1 },
          userOrgs: [{ orgId: 1, name: 'Setplex R&D', role: OrgRole.Admin }],
        },
      },
    });

    expect(screen.getByText('Setplex R&D')).toBeInTheDocument();
    expect(screen.queryByText('Analytix')).not.toBeInTheDocument();
  });

  it('should fall back to the product name when the organization name is unavailable', () => {
    const contextSrv = new ContextSrv();
    contextSrv.user.orgName = '';
    setContextSrv(contextSrv);

    renderWithProvider({
      initialState: {
        organization: {
          organization: { name: 'test', id: 1 },
          userOrgs: [{ orgId: 1, name: 'test', role: OrgRole.Admin }],
        },
      },
    });

    expect(screen.getByText('Analytix')).toBeInTheDocument();
  });

  it('should not render if there is no organisation available', () => {
    renderWithProvider({
      initialState: {
        organization: {
          organization: { name: 'test', id: 1 },
          userOrgs: [],
        },
      },
    });

    expect(screen.queryByRole('combobox', { name: 'Change organization' })).not.toBeInTheDocument();
  });

  it('should not render and not try to get user organizations if not signed in', () => {
    const contextSrv = new ContextSrv();
    contextSrv.user.isSignedIn = false;
    setContextSrv(contextSrv);

    renderWithProvider({
      initialState: {
        organization: {
          organization: { name: 'test', id: 1 },
          userOrgs: [],
        },
      },
    });

    expect(screen.queryByRole('combobox', { name: 'Change organization' })).not.toBeInTheDocument();
    expect(getUserOrganizations).not.toHaveBeenCalled();
  });
});
