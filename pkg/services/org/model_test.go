package org

import (
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestNormalizeProviderIDs(t *testing.T) {
	valid := map[string]string{
		"":                 "",
		"  ":               "",
		"111":              "111",
		" 111 , 222 ":      "111,222",
		"111,111,222":      "111,222",
		"uvo,111":          "uvo,111",
		"UVO_prod,a-b":     "UVO_prod,a-b",
		"*":                "*",
		" * ":              "*",
		",111,,222,":       "111,222",
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
