// The system's description: identification and roles (section 1), its environment (section 2,
// diagrams apart), and the CMMC sections on CUI, assets and service providers.
import {
  ASSET_CATEGORIES,
  ASSET_CATEGORY_LABELS,
  PROVIDER_TYPE_LABELS,
  RESPONSIBILITY_PARTY_LABELS,
  SSP_PROFILE_FIELDS,
  SYSTEM_PROFILE_FIELDS,
  type SspProfile,
  type SystemProfile,
  type SystemProfileFieldKey,
} from '../../src/contract';
import { NONE_RECORDED, cell, field, fieldTable, heading, paragraph } from './common';
import { SSP_SECTIONS } from './sections';
import type { SspBlock, SspSource } from './types';

/** The V1 profile fields that section 2 and the CUI section print instead of section 1. */
const NOT_IN_IDENTIFICATION: readonly SystemProfileFieldKey[] = [
  'authorizationBoundary',
  'environment',
  'interconnections',
  'informationTypes',
];

type SspGroup = (typeof SSP_PROFILE_FIELDS)[number]['group'];

function sspRows(profile: SspProfile, group: SspGroup): [string, string | null][] {
  return SSP_PROFILE_FIELDS.filter((f) => f.group === group).map(({ key, label }) => {
    const value = profile[key];
    return [label, value === null ? null : String(value)];
  });
}

function profileRow(profile: SystemProfile, key: SystemProfileFieldKey): [string, string | null] {
  const found = SYSTEM_PROFILE_FIELDS.find((f) => f.key === key);
  return [found?.label ?? key, profile[key]];
}

export function identificationBlocks(source: SspSource): SspBlock[] {
  const v1 = SYSTEM_PROFILE_FIELDS.filter(({ key }) => !NOT_IN_IDENTIFICATION.includes(key)).map(
    ({ key }) => profileRow(source.profile, key),
  );
  return [
    heading(1, SSP_SECTIONS.identification),
    fieldTable([...v1, ...sspRows(source.sspProfile, 'identification')]),
    heading(2, SSP_SECTIONS.roles),
    source.roles.length === 0
      ? paragraph('No roles recorded.')
      : {
          kind: 'table',
          columns: ['Role', 'Person', 'Responsibilities', 'Users', 'Privileged'],
          rows: source.roles.map((r) => [
            r.title,
            cell(r.person),
            cell(r.responsibilities),
            String(r.userCount),
            r.privileged ? 'Yes' : 'No',
          ]),
        },
    field('Number of users', String(source.roleTotals.users)),
    field('Privileged and administrative users', String(source.roleTotals.privilegedUsers)),
  ];
}

/** Section 2's table: the boundary and environment, then the SSP fields, Interconnections third from last. */
export function environmentTable(source: SspSource): SspBlock {
  const [topology, dataFlow, ...rest] = sspRows(source.sspProfile, 'environment');
  return fieldTable([
    profileRow(source.profile, 'authorizationBoundary'),
    profileRow(source.profile, 'environment'),
    ...(topology === undefined ? [] : [topology]),
    ...(dataFlow === undefined ? [] : [dataFlow]),
    profileRow(source.profile, 'interconnections'),
    ...rest,
  ]);
}

export function cuiBlocks(source: SspSource): SspBlock[] {
  return [
    heading(1, SSP_SECTIONS.cui),
    fieldTable([
      ...sspRows(source.sspProfile, 'cui'),
      profileRow(source.profile, 'informationTypes'),
    ]),
  ];
}

export function assetBlocks(source: SspSource): SspBlock[] {
  return [
    heading(1, SSP_SECTIONS.assets),
    field('Total assets', String(source.assets.length)),
    ...ASSET_CATEGORIES.flatMap((category): SspBlock[] => {
      const assets = source.assets.filter((a) => a.category === category);
      const outOfScope = category === 'out_of_scope';
      return [
        heading(2, `${ASSET_CATEGORY_LABELS[category]} · ${String(assets.length)}`),
        assets.length === 0
          ? paragraph(NONE_RECORDED)
          : {
              kind: 'table',
              columns: [
                'Name',
                'Type',
                'Owner',
                'Location',
                'Treatment',
                ...(outOfScope ? ['Out-of-scope justification'] : []),
              ],
              rows: assets.map((a) => [
                a.name,
                cell(a.assetType),
                cell(a.owner),
                cell(a.location),
                cell(a.treatment),
                ...(outOfScope ? [cell(a.outOfScopeJustification)] : []),
              ]),
            },
      ];
    }),
  ];
}

export function providerBlocks(source: SspSource): SspBlock[] {
  const order = new Map(source.catalog.requirements.map((r, i) => [r.id, i]));
  const rows = source.responsibilities
    .filter((r) => r.party !== null)
    .toSorted(
      (a, b) =>
        (order.get(a.requirementId) ?? Infinity) - (order.get(b.requirementId) ?? Infinity),
    );
  const total = source.catalog.requirements.length;
  return [
    heading(1, SSP_SECTIONS.providers),
    heading(2, 'Service providers'),
    source.providers.length === 0
      ? paragraph('No external service providers recorded.')
      : {
          kind: 'table',
          columns: ['Name', 'Type', 'FedRAMP or equivalent', 'Services', 'Agreement'],
          rows: source.providers.map((p) => [
            p.name,
            PROVIDER_TYPE_LABELS[p.providerType],
            cell(p.fedrampStatus),
            cell(p.services),
            cell(p.agreementReference),
          ]),
        },
    heading(2, 'Customer responsibility matrix'),
    ...(rows.length === 0
      ? []
      : ([
          {
            kind: 'table',
            columns: ['Requirement', 'Party', 'Provider', 'Note'],
            rows: rows.map((r) => [
              r.requirementId,
              r.party === null ? '' : RESPONSIBILITY_PARTY_LABELS[r.party],
              cell(r.provider?.name),
              cell(r.note),
            ]),
          },
        ] satisfies SspBlock[])),
    paragraph(
      `${String(rows.length)} of ${String(total)} requirements have a responsibility recorded.`,
    ),
  ];
}
