package dtos

type UpdateOrgForm struct {
	Name string `json:"name" binding:"Required"`
	// Comma-separated provider ids (PID); nil = keep, "" = clear
	ProviderIds *string `json:"providerIds"`
}

type UpdateOrgAddressForm struct {
	Address1 string `json:"address1"`
	Address2 string `json:"address2"`
	City     string `json:"city"`
	ZipCode  string `json:"zipcode"`
	State    string `json:"state"`
	Country  string `json:"country"`
}
