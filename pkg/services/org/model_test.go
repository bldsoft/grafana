package org

import (
	"fmt"
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

func TestNormalizeGA4PropertyIDs(t *testing.T) {
	valid := map[string]string{
		"":                                "",
		"  ":                              "",
		" , ,":                            "",
		"123456789":                       "123456789",
		" 123456789 , 987654321 ":         "123456789,987654321",
		"properties/123456789":            "123456789",
		"properties/123456789, 987654321": "123456789,987654321",
		"123,456,123":                     "123,456",
		"properties/123,123":              "123",
		",123,,456,":                      "123,456",
		strings.Repeat("9", 20):           strings.Repeat("9", 20),
	}
	for raw, want := range valid {
		got, err := NormalizeGA4PropertyIDs(raw)
		require.NoError(t, err, "raw=%q", raw)
		assert.Equal(t, want, got, "raw=%q", raw)
	}

	// 52 distinct 20-digit ids joined by commas exceed the 1024-char column.
	tooLong := make([]string, 0, 52)
	for i := 0; i < 52; i++ {
		tooLong = append(tooLong, fmt.Sprintf("%020d", i))
	}

	invalid := []string{
		"abc",
		"123a",
		"*",
		"123;456",
		"1 2",
		"properties/",
		"properties/abc",
		"property/123",
		"-123",
		strings.Repeat("9", 21),
		strings.Join(tooLong, ","),
	}
	for _, raw := range invalid {
		_, err := NormalizeGA4PropertyIDs(raw)
		assert.ErrorIs(t, err, ErrInvalidGA4PropertyIDs, "raw=%q", raw)
	}
}
