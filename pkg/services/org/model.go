package org

import (
	"errors"
	"strings"
	"time"

	"github.com/grafana/grafana/pkg/apimachinery/errutil"
	"github.com/grafana/grafana/pkg/apimachinery/identity"
	"github.com/grafana/grafana/pkg/services/search/model"
)

// Typed errors
var (
	ErrOrgNameTaken                            = errors.New("organization name is taken")
	ErrLastOrgAdmin                            = errors.New("cannot remove last organization admin")
	ErrOrgUserNotFound                         = errors.New("cannot find the organization user")
	ErrOrgUserAlreadyAdded                     = errors.New("user is already added to organization")
	ErrOrgNotFound                             = errutil.NotFound("org.notFound", errutil.WithPublicMessage("organization not found"))
	ErrInvalidProviderIDs                      = errors.New("provider ids must be \"*\" or a comma-separated list of alphanumeric ids")
	ErrInvalidExternalServicesTeamID           = errors.New("external services team id must be a single team UID or numeric id")
	ErrCannotChangeRoleForExternallySyncedUser = errutil.Forbidden("org.externallySynced", errutil.WithPublicMessage("cannot change role for externally synced user"))
)

type Org struct {
	ID      int64 `xorm:"pk autoincr 'id'"`
	Version int
	Name    string

	Address1 string
	Address2 string
	City     string
	ZipCode  string
	State    string
	Country  string

	// Comma-separated provider ids (PID) this organization is allowed to query
	ProviderIDs string `xorm:"provider_ids"`
	// UID (or numeric id) of the team whose members may use external services
	// such as AI Insider; empty = the services are off for this organization
	ExternalServicesTeamID string `xorm:"external_services_team_id"`

	Created time.Time
	Updated time.Time
}
type OrgUser struct {
	ID      int64 `xorm:"pk autoincr 'id'"`
	OrgID   int64 `xorm:"org_id"`
	UserID  int64 `xorm:"user_id"`
	Role    RoleType
	Created time.Time
	Updated time.Time
}

type RoleType = identity.RoleType

const (
	RoleNone   RoleType = identity.RoleNone
	RoleViewer RoleType = identity.RoleViewer
	RoleEditor RoleType = identity.RoleEditor
	RoleAdmin  RoleType = identity.RoleAdmin
)

type CreateOrgCommand struct {
	Name string `json:"name" binding:"Required"`

	// Comma-separated provider ids (PID) this organization is allowed to query
	ProviderIDs string `json:"providerIds" xorm:"provider_ids"`
	// UID (or numeric id) of the team whose members may use external services
	ExternalServicesTeamID string `json:"externalServicesTeamId" xorm:"external_services_team_id"`

	// initial admin user for account
	UserID int64 `json:"-" xorm:"user_id"`
}

type GetOrgIDForNewUserCommand struct {
	Email        string
	Login        string
	OrgID        int64
	OrgName      string
	SkipOrgSetup bool
}

type GetUserOrgListQuery struct {
	UserID int64 `xorm:"user_id"`
}

type UserOrgDTO struct {
	OrgID int64    `json:"orgId" xorm:"org_id"`
	Name  string   `json:"name"`
	Role  RoleType `json:"role"`
}

type UpdateOrgCommand struct {
	Name  string
	OrgId int64
	// nil = keep the stored value, non-nil (including "") = overwrite
	ProviderIDs *string
	// nil = keep the stored value, non-nil (including "") = overwrite
	ExternalServicesTeamID *string
}

type SearchOrgsQuery struct {
	Query string
	Name  string
	Limit int
	Page  int
	IDs   []int64 `xorm:"ids"`
}

type OrgDTO struct {
	ID   int64  `json:"id" xorm:"id"`
	Name string `json:"name"`
}

type GetOrgByIDQuery struct {
	ID int64
}

type GetOrgByNameQuery struct {
	Name string
}

type UpdateOrgAddressCommand struct {
	OrgID int64 `xorm:"org_id"`
	Address
}

type Address struct {
	Address1 string `json:"address1"`
	Address2 string `json:"address2"`
	City     string `json:"city"`
	ZipCode  string `json:"zipCode"`
	State    string `json:"state"`
	Country  string `json:"country"`
}

type DeleteOrgCommand struct {
	ID int64 `xorm:"id"`
}

type AddOrgUserCommand struct {
	LoginOrEmail string   `json:"loginOrEmail" binding:"Required"`
	Role         RoleType `json:"role" binding:"Required"`

	OrgID  int64 `json:"-" xorm:"org_id"`
	UserID int64 `json:"-" xorm:"user_id"`

	// internal use: avoid adding service accounts to orgs via user routes
	AllowAddingServiceAccount bool `json:"-"`
}

type UpdateOrgUserCommand struct {
	Role RoleType `json:"role" binding:"Required"`

	OrgID  int64 `json:"-"`
	UserID int64 `json:"-"`
}

type OrgUserDTO struct {
	OrgID              int64           `json:"orgId" xorm:"org_id"`
	UserID             int64           `json:"userId" xorm:"user_id"`
	UID                string          `json:"uid" xorm:"uid"`
	Email              string          `json:"email"`
	Name               string          `json:"name"`
	AvatarURL          string          `json:"avatarUrl" xorm:"avatar_url"`
	Login              string          `json:"login"`
	Role               string          `json:"role"`
	LastSeenAt         time.Time       `json:"lastSeenAt"`
	Updated            time.Time       `json:"-"`
	Created            time.Time       `json:"created"`
	LastSeenAtAge      string          `json:"lastSeenAtAge"`
	AccessControl      map[string]bool `json:"accessControl,omitempty"`
	IsDisabled         bool            `json:"isDisabled"`
	AuthLabels         []string        `json:"authLabels" xorm:"-"`
	IsExternallySynced bool            `json:"isExternallySynced"`
	IsProvisioned      bool            `json:"isProvisioned"`
}

type RemoveOrgUserCommand struct {
	UserID                   int64 `xorm:"user_id"`
	OrgID                    int64 `xorm:"org_id"`
	ShouldDeleteOrphanedUser bool
	UserWasDeleted           bool
}

type GetOrgUsersQuery struct {
	UserID int64 `xorm:"user_id"`
	OrgID  int64 `xorm:"org_id"`
	Query  string
	Page   int
	Limit  int
	// Flag used to allow oss edition to query users without access control
	DontEnforceAccessControl bool

	User identity.Requester
}

type SearchOrgUsersQuery struct {
	UserID   int64 `xorm:"user_id"`
	OrgID    int64 `xorm:"org_id"`
	Query    string
	Page     int
	Limit    int
	SortOpts []model.SortOption
	// Flag used to allow oss edition to query users without access control
	DontEnforceAccessControl bool
	// Flag used to exclude hidden users from the result
	ExcludeHiddenUsers bool

	User identity.Requester
}

type SearchOrgUsersQueryResult struct {
	TotalCount int64         `json:"totalCount"`
	OrgUsers   []*OrgUserDTO `json:"orgUsers"`
	Page       int           `json:"page"`
	PerPage    int           `json:"perPage"`
}

type ByOrgName []*UserOrgDTO

type OrgDetailsDTO struct {
	ID                     int64   `json:"id"`
	Name                   string  `json:"name"`
	Address                Address `json:"address"`
	ProviderIDs            string  `json:"providerIds"`
	ExternalServicesTeamID string  `json:"externalServicesTeamId"`
}

// NormalizeExternalServicesTeamID canonicalizes the external services team
// id: whitespace is trimmed and the result must be empty or a single team UID
// / numeric id (letters, digits, "_", "-"). Empty means no team is assigned,
// so nobody in the organization gets the external services (fail closed).
func NormalizeExternalServicesTeamID(raw string) (string, error) {
	id := strings.TrimSpace(raw)
	if len(id) > 190 {
		return "", ErrInvalidExternalServicesTeamID
	}
	for _, r := range id {
		ok := (r >= '0' && r <= '9') || (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || r == '_' || r == '-'
		if !ok {
			return "", ErrInvalidExternalServicesTeamID
		}
	}
	return id, nil
}

// NormalizeProviderIDs canonicalizes the provider id list: "*" alone grants
// every provider; otherwise a comma-separated list of ids (letters, digits,
// "_", "-") with whitespace, empty items and duplicates dropped. Returns the
// "111,uvo" form. An EMPTY result means no providers: organizations without
// an explicit list get no data access (fail closed), so "*" must be set
// deliberately.
func NormalizeProviderIDs(raw string) (string, error) {
	parts := strings.Split(raw, ",")
	seen := make(map[string]struct{}, len(parts))
	out := make([]string, 0, len(parts))
	wildcard := false
	for _, part := range parts {
		part = strings.TrimSpace(part)
		if part == "" {
			continue
		}
		if part == "*" {
			wildcard = true
			continue
		}
		for _, r := range part {
			ok := (r >= '0' && r <= '9') || (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || r == '_' || r == '-'
			if !ok {
				return "", ErrInvalidProviderIDs
			}
		}
		if _, ok := seen[part]; ok {
			continue
		}
		seen[part] = struct{}{}
		out = append(out, part)
	}
	if wildcard {
		// "*" mixed with concrete ids is ambiguous — refuse instead of guessing.
		if len(out) > 0 {
			return "", ErrInvalidProviderIDs
		}
		return "*", nil
	}
	return strings.Join(out, ","), nil
}

// Len returns the length of an array of organisations.
func (o ByOrgName) Len() int {
	return len(o)
}

// Swap swaps two indices of an array of organizations.
func (o ByOrgName) Swap(i, j int) {
	o[i], o[j] = o[j], o[i]
}

// Less returns whether element i of an array of organizations is less than element j.
func (o ByOrgName) Less(i, j int) bool {
	if strings.ToLower(o[i].Name) < strings.ToLower(o[j].Name) {
		return true
	}

	return o[i].Name < o[j].Name
}

const (
	QuotaTargetSrv     string = "org"
	OrgQuotaTarget     string = "org"
	OrgUserQuotaTarget string = "org_user"
)
