package org

import (
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestNormalizeProviderIDs(t *testing.T) {
	valid := map[string]string{
		"":             "",
		"  ":           "",
		"111":          "111",
		" 111 , 222 ":  "111,222",
		"111,111,222":  "111,222",
		"uvo,111":      "uvo,111",
		"UVO_prod,a-b": "UVO_prod,a-b",
		"*":            "*",
		" * ":          "*",
		",111,,222,":   "111,222",
	}
	for raw, want := range valid {
		got, err := NormalizeProviderIDs(raw)
		require.NoError(t, err, "raw=%q", raw)
		assert.Equal(t, want, got, "raw=%q", raw)
	}

	invalid := []string{"111;222", "1 2", "*,111", "111,*", "u.vo", "'111'", "%"}
	for _, raw := range invalid {
		_, err := NormalizeProviderIDs(raw)
		assert.ErrorIs(t, err, ErrInvalidProviderIDs, "raw=%q", raw)
	}
}

func TestNormalizeExternalServicesTeamID(t *testing.T) {
	valid := map[string]string{
		"":                 "",
		"  ":               "",
		"cfwubwdg1oxdsf":   "cfwubwdg1oxdsf",
		" afw9ckp7tmigwa ": "afw9ckp7tmigwa",
		"6":                "6",
		"team_a-1":         "team_a-1",
	}
	for raw, want := range valid {
		got, err := NormalizeExternalServicesTeamID(raw)
		require.NoError(t, err, "raw=%q", raw)
		assert.Equal(t, want, got, "raw=%q", raw)
	}

	invalid := []string{"a,b", "a b", "*", "u.id", "'x'", "%", strings.Repeat("a", 191)}
	for _, raw := range invalid {
		_, err := NormalizeExternalServicesTeamID(raw)
		assert.ErrorIs(t, err, ErrInvalidExternalServicesTeamID, "raw=%q", raw)
	}
}
