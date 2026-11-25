# Onboarding a community

About an hour for a 300-unit community, most of it preparing the spreadsheet.

## 1. Create the community (our team)

```sh
DATABASE_URL_PLATFORM=… PRAGATI_BASE_DOMAIN=pragati.example \
npm run platform -- create riverside-greens "Riverside Greens" "Riverside Greens Residents Welfare Association" Chennai community "Riverside Greens" "Arjun Menon" 9840012345
```

- `riverside-greens` becomes the web address: riverside-greens.pragati.example. A community's own domain can be added after it.
- "Riverside Greens" becomes the platform name, **Riverside Greens Pragati**. The community can change it later.
- Use `federation` instead of `community` for a township or federation of associations.

This creates the top of the property tree, the standard unit types and roles, a managing committee (or federation council), JAOA's default approval rule (every committee member approves), and the administrator, who can sign in straight away.

Add the address to the installation's `community_domains` in Terraform so Front Door issues its certificate.

## 2. Prepare the spreadsheet (the community, with our help)

One row per unit, saved as CSV:

| location | unit | type | floor | carpet_sqft | super_sqft | uds_sqft | plot_sqft | owner_name | owner_phone | owner_share |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Ganga Block > Wing 1 > Floor 3 | G1-301 | 2BHK | 3 | 1120 | 1440 | 470 | | Asha Raman;Ravi Raman | 98400 11111;98400 22222 | 50;50 |
| Phase 2 > street:Palm Avenue | PALM-V07 | Villa | | 2600 | | 2400 | 2400 | Lakshmi Iyer | 98400 33333 | 100 |

- **location** lists the places below the community, separated by `>`. The kind comes from the first word (Block, Tower, Wing, Phase, Zone, Floor, Street, Cluster) or a prefix such as `street:Palm Avenue`.
- **type** is a unit type's name or code (Studio, 1 BHK, 2.5BHK, Villa, Shop…). Add any missing types under Unit types first.
- Joint owners are separated by `;` in the three owner columns. Shares default to equal parts.
- Owners with a mobile number get the Owner role and can sign in.

## 3. Import and set up (the community's administrator)

1. **Places › Import units**: check the file. The preview lists every problem by row; fix them in the spreadsheet and check again. Import saves everything at once, or nothing.
2. **People › Committees**: add the committee members, and block or phase committees if they have them.
3. **People**: give committee members the Committee member or Office bearer role (office bearers can record signed letters); give block committee members their role for their block only.
4. **More › Approval rules**: replace or add to the default rule, for example "Block costs under ₹2 lakh: the block committee, by majority".
5. **More › Platform name and look**: colour, logo, languages.

## 4. Before inviting residents

- Raise one test approval request and check it reaches the right committee.
- Send the privacy notice (see `docs/security-and-dpdp.md`).
- Share the web address in the community's WhatsApp groups.
