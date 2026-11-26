import { loadCatalog, type Requirement } from '@rampart/catalog';
import { evaluateAssessment, type ObjectiveStatus } from '@rampart/rules';
import { REGULATION, closeoutClock } from '@rampart/rules/poam';
import { describe, expect, it } from 'vitest';
import {
  ASSET_CATEGORIES,
  ASSET_CATEGORY_LABELS,
  DEFAULT_CATEGORIZATION,
  SSP_PROFILE_FIELDS,
  SYSTEM_PROFILE_FIELDS,
  type AssessmentView,
  type Asset,
  type DiagramLink,
  type DocumentControl,
  type EvidenceItem,
  type Policy,
  type PoamItem,
  type RequirementState,
  type ResponsibilityRow,
  type ServiceProvider,
  type SspApproval,
  type SspProfile,
  type SspRevision,
  type SystemProfile,
  type SystemRole,
} from '../src/contract';
import { exportRevisionDescription } from './index';
import { buildSspModel, type SspBlock, type SspExportEntry, type SspModel } from './model';
import { jpegOf, pngOf } from './testing/docx-text';

const catalog = loadCatalog();
const AT = '2026-11-23T09:00:00.000Z';
const TODAY = '2026-11-23';
const ADA = { id: 'u-ada', displayName: 'Ada Admin' };

const OUTLINE = [
  '1. System identification',
  '2. System environment',
  'CMMC: CUI description',
  'CMMC: Asset inventory',
  'CMMC: External service providers and responsibilities',
  '3. Requirements',
  '4. Record of changes',
  'Approvals',
  'Appendix A — Assessment status',
  'Appendix B — Assessment objectives',
];

function requirement(id: string): Requirement {
  const found = catalog.requirements.find((r) => r.id === id);
  if (!found) throw new Error(`no ${id}`);
  return found;
}

/** Every objective of these requirements (or of all of them) at one status. */
function results(
  status: ObjectiveStatus,
  ids?: readonly string[],
): Record<string, ObjectiveStatus> {
  const out: Record<string, ObjectiveStatus> = {};
  for (const r of catalog.requirements) {
    if (ids && !ids.includes(r.id)) continue;
    for (const o of r.objectives) out[o.id] = status;
  }
  return out;
}

const EMPTY_PROFILE: SystemProfile = {
  ...(Object.fromEntries(SYSTEM_PROFILE_FIELDS.map(({ key }) => [key, null])) as Record<
    (typeof SYSTEM_PROFILE_FIELDS)[number]['key'],
    null
  >),
  updatedAt: null,
  updatedBy: null,
};

/** What `GET /api/ssp/profile` reads with no saved row. */
const EMPTY_SSP_PROFILE: SspProfile = {
  categorization: DEFAULT_CATEGORIZATION,
  securityOfficer: null,
  securityOfficerEmail: null,
  organizationAddress: null,
  organizationPhone: null,
  cuiCategories: null,
  cuiLocations: null,
  cuiEntryExit: null,
  topologyNarrative: null,
  dataFlowNarrative: null,
  inventoryReference: null,
  maintenanceStatement: null,
  reviewCadenceMonths: 12,
  nextReviewDate: null,
  updatedAt: null,
  updatedBy: null,
};

const EMPTY_CONTROL: DocumentControl = {
  reviewCadenceMonths: 12,
  nextReviewDate: null,
  nextReviewDue: null,
  daysToReview: null,
  reviewOverdue: false,
  revisions: [],
  approvals: [],
};

function state(requirementId: string, fields: Partial<RequirementState>): RequirementState {
  return {
    requirementId,
    implementationLevel: null,
    implementationStatement: null,
    owner: null,
    plannedImplementation: null,
    naRationale: null,
    updatedAt: AT,
    ...fields,
  };
}

function poamItem(requirementId: string, fields: Partial<PoamItem> = {}): PoamItem {
  return {
    id: `item-${requirementId}`,
    requirementId,
    status: 'open',
    plan: 'Fix it.',
    due: '2027-01-15',
    milestones: [],
    owner: null,
    createdAt: AT,
    createdBy: ADA,
    updatedAt: AT,
    closeout: null,
    requirementStatus: 'not_met',
    eligibility: { eligible: true },
    daysToDue: 53,
    overdue: false,
    dueAfterDeadline: false,
    readyToClose: false,
    ...fields,
  };
}

function policy(title: string, requirementIds: string[]): Policy {
  return {
    id: `policy-${title}`,
    title,
    description: null,
    requirementIds,
    versions: [],
    createdAt: AT,
    createdBy: ADA,
    updatedAt: AT,
  };
}

function evidence(title: string, objectiveIds: string[]): EvidenceItem {
  return {
    id: `evidence-${title}`,
    title,
    description: null,
    containsCui: false,
    objectiveIds,
    versions: [],
    createdAt: AT,
    createdBy: ADA,
    updatedAt: AT,
  };
}

function role(title: string, fields: Partial<SystemRole> = {}): SystemRole {
  return {
    id: `role-${title}`,
    title,
    person: null,
    responsibilities: null,
    userCount: 1,
    privileged: false,
    createdAt: AT,
    updatedAt: AT,
    ...fields,
  };
}

function asset(name: string, category: Asset['category'], fields: Partial<Asset> = {}): Asset {
  return {
    id: `asset-${name}`,
    name,
    category,
    assetType: null,
    owner: null,
    location: null,
    treatment: null,
    outOfScopeJustification: null,
    createdAt: AT,
    updatedAt: AT,
    ...fields,
  };
}

function provider(name: string, fields: Partial<ServiceProvider> = {}): ServiceProvider {
  return {
    id: `provider-${name}`,
    name,
    providerType: 'cloud',
    fedrampStatus: null,
    services: null,
    agreementReference: null,
    createdAt: AT,
    updatedAt: AT,
    ...fields,
  };
}

/** A diagram link to a file version; `fields` and `file` override the defaults. */
function fileLink(
  caption: string,
  fileName: string,
  fields: Partial<DiagramLink> = {},
  file: Partial<NonNullable<DiagramLink['resolved']>> = {},
): DiagramLink {
  return {
    id: `link-${caption}`,
    kind: 'network',
    caption,
    evidence: { id: `evidence-${caption}`, title: `${caption} file`, containsCui: false },
    version: null,
    resolved: {
      version: 1,
      kind: 'file',
      fileName,
      size: 1000,
      sha256: `sha-${caption}`,
      location: null,
      createdAt: '2026-11-20T23:30:00.000Z',
      ...file,
    },
    embeddable: /\.(png|jpe?g)$/i.test(fileName),
    createdAt: AT,
    updatedAt: AT,
    ...fields,
  };
}

function revision(date: string, description: string, madeBy: string): SspRevision {
  return {
    id: `rev-${date}-${description}`,
    kind: 'manual',
    date,
    description,
    madeBy,
    createdAt: AT,
  };
}

function approval(name: string, title: string, approvedOn: string | null): SspApproval {
  return { id: `approval-${name}`, name, title, approvedOn, createdAt: AT, updatedAt: AT };
}

interface World {
  statuses?: Record<string, ObjectiveStatus>;
  notes?: Record<string, string>;
  states?: RequirementState[];
  items?: PoamItem[];
  policies?: Policy[];
  evidence?: EvidenceItem[];
  profile?: Partial<SystemProfile>;
  sspProfile?: Partial<SspProfile>;
  conditionalStatusDate?: string | null;
  roles?: SystemRole[];
  assets?: Asset[];
  providers?: ServiceProvider[];
  responsibilities?: Record<string, Partial<ResponsibilityRow>>;
  diagrams?: DiagramLink[];
  images?: Record<string, Uint8Array>;
  maxEmbeddedImages?: number;
  control?: Partial<DocumentControl>;
  exportEntry?: SspExportEntry | null;
}

/** The model of a world built the way the api builds its views, with the real rules. */
function modelOf(world: World = {}): SspModel {
  const statuses = world.statuses ?? {};
  const items = world.items ?? [];
  const objectiveResults = Object.entries(statuses).map(([objectiveId, status]) => ({
    objectiveId,
    status,
  }));
  const openPoamRequirementIds = catalog.requirements
    .map((r) => r.id)
    .filter((id) => items.some((i) => i.requirementId === id && i.status === 'open'));
  const date = world.conditionalStatusDate ?? null;
  const closeout = date === null ? null : closeoutClock(date, TODAY, REGULATION);
  const view: AssessmentView = {
    assessment: {
      id: 'assessment-1',
      type: 'self',
      conditionalStatusDate: date,
      catalogVersion: 'nist-800-171-r2@1.0.0',
      updatedAt: AT,
    },
    objectiveResults: objectiveResults.map((r) => ({
      ...r,
      note: world.notes?.[r.objectiveId] ?? null,
      updatedAt: AT,
      updatedBy: ADA,
    })),
    requirementStates: world.states ?? [],
    openPoamRequirementIds,
    evaluation: evaluateAssessment(
      catalog,
      {
        objectiveResults,
        implementationLevels: Object.fromEntries(
          (world.states ?? []).flatMap((s) =>
            s.implementationLevel === null ? [] : [[s.requirementId, s.implementationLevel]],
          ),
        ),
        openPoamRequirementIds,
      },
      REGULATION,
    ),
    closeout,
  };
  const roles = world.roles ?? [];
  return buildSspModel({
    catalog,
    profile: { ...EMPTY_PROFILE, ...world.profile },
    view,
    poam: { items, candidates: [], closeout, confirmer: 'organization' },
    policies: world.policies ?? [],
    evidence: world.evidence ?? [],
    sspProfile: { ...EMPTY_SSP_PROFILE, ...world.sspProfile },
    roles,
    roleTotals: {
      users: roles.reduce((sum, r) => sum + r.userCount, 0),
      privilegedUsers: roles.reduce((sum, r) => sum + (r.privileged ? r.userCount : 0), 0),
    },
    assets: world.assets ?? [],
    providers: world.providers ?? [],
    responsibilities: catalog.requirements.map((r) => ({
      requirementId: r.id,
      party: null,
      provider: null,
      note: null,
      updatedAt: null,
      ...world.responsibilities?.[r.id],
    })),
    diagrams: world.diagrams ?? [],
    documentControl: { ...EMPTY_CONTROL, ...world.control },
    images: new Map(Object.entries(world.images ?? {})),
    maxEmbeddedImages: world.maxEmbeddedImages ?? 10,
    exportEntry: world.exportEntry ?? null,
  });
}

const headings = (blocks: SspBlock[], level: 1 | 2 | 3) =>
  blocks.flatMap((b) => (b.kind === 'heading' && b.level === level ? [b.text] : []));

/** The blocks after the heading with this text, up to the next heading of that level or higher. */
function sectionOf(model: SspModel, text: string): SspBlock[] {
  const start = model.blocks.findIndex((b) => b.kind === 'heading' && b.text === text);
  expect(start, `a heading "${text}"`).not.toBe(-1);
  const head = model.blocks[start];
  if (head?.kind !== 'heading') return [];
  const rest = model.blocks.slice(start + 1);
  const end = rest.findIndex((b) => b.kind === 'heading' && b.level <= head.level);
  return end === -1 ? rest : rest.slice(0, end);
}

/** The blocks of a requirement: inside section 3, from its heading to the next. */
function requirementSection(model: SspModel, id: string): SspBlock[] {
  return sectionOf(model, id);
}

function fieldOf(blocks: SspBlock[], label: string): string | undefined {
  for (const b of blocks) if (b.kind === 'field' && b.label === label) return b.value;
  return undefined;
}

function textOf(blocks: SspBlock[], label: string): string | undefined {
  for (const b of blocks) if (b.kind === 'text' && b.label === label) return b.text;
  return undefined;
}

function listOf(blocks: SspBlock[], label: string): string[] | string | undefined {
  for (const b of blocks) {
    if (b.kind === 'list' && b.label === label) return b.items.length > 0 ? b.items : b.empty;
  }
  return undefined;
}

function tablesOf(blocks: SspBlock[]): { columns: string[]; rows: string[][] }[] {
  return blocks.flatMap((b) => (b.kind === 'table' ? [{ columns: b.columns, rows: b.rows }] : []));
}

function tableOf(blocks: SspBlock[]): { columns: string[]; rows: string[][] } {
  const [first] = tablesOf(blocks);
  if (first === undefined) expect.unreachable('no table');
  return first;
}

function paragraphs(blocks: SspBlock[]): string[] {
  return blocks.flatMap((b) => (b.kind === 'paragraph' ? [b.text] : []));
}

/** The blocks under a level-1 heading but before its first sub-heading. */
function leadOf(model: SspModel, text: string): SspBlock[] {
  const blocks = sectionOf(model, text);
  const end = blocks.findIndex((b) => b.kind === 'heading');
  return end === -1 ? blocks : blocks.slice(0, end);
}

describe('buildSspModel', () => {
  it('v2 outline order', () => {
    const model = modelOf({ profile: { systemName: 'Enclave One' } });
    expect(model.blocks.slice(0, 3)).toEqual([
      { kind: 'title', text: 'System Security Plan' },
      { kind: 'subtitle', text: 'Enclave One' },
      { kind: 'generated' },
    ]);
    expect(model.blocks[3]).toEqual({ kind: 'heading', level: 1, text: OUTLINE[0] });
    expect(headings(model.blocks, 1)).toEqual(OUTLINE);
    expect(modelOf().blocks[1]).toEqual({ kind: 'subtitle', text: 'System not named' });

    // Section 3 keeps V1's structure: every family in order, each requirement under its family.
    const section3 = sectionOf(model, '3. Requirements');
    expect(headings(section3, 2)).toEqual(
      catalog.families.map((f) => `${f.nistSection} ${f.name} (${f.code})`),
    );
    expect(headings(section3, 3)).toEqual(catalog.requirements.map((r) => r.id));
    for (const family of catalog.families) {
      const under = sectionOf(model, `${family.nistSection} ${family.name} (${family.code})`);
      expect(headings(under, 3)).toEqual(family.requirementIds);
    }
    // No requirement heading anywhere else.
    expect(headings(model.blocks, 3)).toHaveLength(110);
  });

  it('identification and roles', () => {
    const profile = {
      systemName: 'Enclave One',
      cageCode: '1ABC2',
      description: 'Line one\nLine two',
      authorizationBoundary: 'The enclave',
      systemOwnerEmail: 'owner@example.com',
    };
    const model = modelOf({
      profile,
      sspProfile: { securityOfficer: 'Sam Officer', organizationPhone: '+1 555 0100' },
      roles: [
        role('Administrator', {
          person: 'Ada Admin',
          responsibilities: 'Runs the enclave',
          userCount: 2,
          privileged: true,
        }),
        role('Engineer', { userCount: 10 }),
      ],
    });
    const lead = leadOf(model, '1. System identification');
    const table = tableOf(lead);
    expect(table.columns).toEqual(['Field', 'Value']);
    const moved = ['authorizationBoundary', 'environment', 'interconnections', 'informationTypes'];
    const v1 = SYSTEM_PROFILE_FIELDS.filter(({ key }) => !moved.includes(key));
    const identification = SSP_PROFILE_FIELDS.filter((f) => f.group === 'identification');
    expect(table.rows).toEqual([
      ...v1.map(({ key, label }) => [
        label,
        (profile as Partial<Record<string, string>>)[key] ?? 'Not provided',
      ]),
      ['Security categorization', DEFAULT_CATEGORIZATION],
      ['System security officer', 'Sam Officer'],
      ['System security officer email', 'Not provided'],
      ['Organization address', 'Not provided'],
      ['Organization phone', '+1 555 0100'],
    ]);
    expect(identification.map((f) => f.label)).toEqual(table.rows.slice(v1.length).map((r) => r[0]));
    // The boundary is not in section 1.
    expect(table.rows.map((r) => r[0])).not.toContain('Authorization boundary');

    // A set categorization reads as itself.
    const set = modelOf({ sspProfile: { categorization: 'High impact' } });
    expect(tableOf(leadOf(set, '1. System identification')).rows).toContainEqual([
      'Security categorization',
      'High impact',
    ]);

    // Roles and both totals.
    const roles = sectionOf(model, '1.1 Roles and users');
    expect(tableOf(roles)).toEqual({
      columns: ['Role', 'Person', 'Responsibilities', 'Users', 'Privileged'],
      rows: [
        ['Administrator', 'Ada Admin', 'Runs the enclave', '2', 'Yes'],
        ['Engineer', '', '', '10', 'No'],
      ],
    });
    expect(fieldOf(roles, 'Number of users')).toBe('12');
    expect(fieldOf(roles, 'Privileged and administrative users')).toBe('2');

    const none = sectionOf(modelOf(), '1.1 Roles and users');
    expect(tablesOf(none)).toEqual([]);
    expect(paragraphs(none)).toEqual(['No roles recorded.']);
    expect(fieldOf(none, 'Number of users')).toBe('0');
    expect(fieldOf(none, 'Privileged and administrative users')).toBe('0');
  });

  it('environment and CUI rows', () => {
    const model = modelOf({
      profile: {
        authorizationBoundary: 'Boundary text',
        environment: 'On premises',
        interconnections: 'None outside',
        informationTypes: 'Drawings',
      },
      sspProfile: {
        topologyNarrative: 'One flat network',
        dataFlowNarrative: 'CUI enters by email',
        maintenanceStatement: 'IT owns it',
        cuiCategories: 'CTI',
        cuiEntryExit: 'Email only',
      },
    });
    const environment = tableOf(leadOf(model, '2. System environment'));
    expect(environment.columns).toEqual(['Field', 'Value']);
    expect(environment.rows).toEqual([
      ['Authorization boundary', 'Boundary text'],
      ['Operating environment', 'On premises'],
      ['Network topology', 'One flat network'],
      ['CUI data flow', 'CUI enters by email'],
      ['Interconnections with other systems', 'None outside'],
      ['Hardware and software inventory', 'Not provided'],
      ['Maintenance and ownership', 'IT owns it'],
    ]);
    const cui = sectionOf(model, 'CMMC: CUI description');
    expect(tableOf(cui)).toEqual({
      columns: ['Field', 'Value'],
      rows: [
        ['CUI categories (CUI Registry)', 'CTI'],
        ['Where CUI is stored, processed or transmitted', 'Not provided'],
        ['How CUI enters and leaves the system', 'Email only'],
        ['Information types handled', 'Drawings'],
      ],
    });
  });

  it('asset inventory', () => {
    const model = modelOf({
      assets: [
        asset('File server', 'cui', {
          assetType: 'Server',
          owner: 'IT',
          location: 'Rack 1',
          treatment: 'Encrypted',
        }),
        asset('Laptop', 'cui'),
        asset('Firewall', 'spa', { outOfScopeJustification: 'kept from an earlier category' }),
        asset('Guest Wi-Fi', 'out_of_scope', { outOfScopeJustification: 'No CUI path' }),
      ],
    });
    const section = sectionOf(model, 'CMMC: Asset inventory');
    expect(fieldOf(section, 'Total assets')).toBe('4');
    const counts = { cui: 2, spa: 1, crma: 0, specialized: 0, out_of_scope: 1 };
    expect(headings(section, 2)).toEqual(
      ASSET_CATEGORIES.map((c) => `${ASSET_CATEGORY_LABELS[c]} · ${String(counts[c])}`),
    );
    const columns = ['Name', 'Type', 'Owner', 'Location', 'Treatment'];
    expect(tableOf(sectionOf(model, 'CUI Assets · 2'))).toEqual({
      columns,
      rows: [
        ['File server', 'Server', 'IT', 'Rack 1', 'Encrypted'],
        ['Laptop', '', '', '', ''],
      ],
    });
    // Another category's leftover justification is not printed.
    expect(tableOf(sectionOf(model, 'Security Protection Assets · 1'))).toEqual({
      columns,
      rows: [['Firewall', '', '', '', '']],
    });
    for (const empty of ['Contractor Risk Managed Assets · 0', 'Specialized Assets · 0']) {
      expect(sectionOf(model, empty)).toEqual([{ kind: 'paragraph', text: 'None recorded.' }]);
    }
    expect(tableOf(sectionOf(model, 'Out-of-Scope Assets · 1'))).toEqual({
      columns: [...columns, 'Out-of-scope justification'],
      rows: [['Guest Wi-Fi', '', '', '', '', 'No CUI path']],
    });

    // No assets: every group says so.
    const none = sectionOf(modelOf(), 'CMMC: Asset inventory');
    expect(fieldOf(none, 'Total assets')).toBe('0');
    expect(paragraphs(none)).toEqual(ASSET_CATEGORIES.map(() => 'None recorded.'));
  });

  it('providers and matrix', () => {
    const cloud = provider('Cloud Co', {
      fedrampStatus: 'FedRAMP Moderate',
      services: 'Email\nFiles',
      agreementReference: 'MSA-1',
    });
    const msp = provider('Help Desk', { providerType: 'msp' });
    const late = catalog.requirements[100]?.id ?? '';
    const model = modelOf({
      providers: [cloud, msp],
      responsibilities: {
        // Given out of catalog order on purpose: the document is in catalog order.
        [late]: { party: 'organization', note: 'We do it' },
        'AC.L2-3.1.1': { party: 'esp', provider: { id: cloud.id, name: cloud.name } },
        'AC.L2-3.1.2': { party: 'shared', provider: { id: msp.id, name: msp.name }, note: 'Split' },
        // A note with no party is not a recorded responsibility.
        'AC.L2-3.1.3': { note: 'stale' },
      },
    });
    expect(tableOf(sectionOf(model, 'Service providers'))).toEqual({
      columns: ['Name', 'Type', 'FedRAMP or equivalent', 'Services', 'Agreement'],
      rows: [
        ['Cloud Co', 'Cloud service provider', 'FedRAMP Moderate', 'Email\nFiles', 'MSA-1'],
        ['Help Desk', 'Managed service provider', '', '', ''],
      ],
    });
    const matrix = sectionOf(model, 'Customer responsibility matrix');
    expect(tableOf(matrix)).toEqual({
      columns: ['Requirement', 'Party', 'Provider', 'Note'],
      rows: [
        ['AC.L2-3.1.1', 'ESP', 'Cloud Co', ''],
        ['AC.L2-3.1.2', 'Shared', 'Help Desk', 'Split'],
        [late, 'Organization', '', 'We do it'],
      ],
    });
    expect(paragraphs(matrix)).toEqual(['3 of 110 requirements have a responsibility recorded.']);

    const none = modelOf();
    expect(sectionOf(none, 'Service providers')).toEqual([
      { kind: 'paragraph', text: 'No external service providers recorded.' },
    ]);
    expect(sectionOf(none, 'Customer responsibility matrix')).toEqual([
      { kind: 'paragraph', text: '0 of 110 requirements have a responsibility recorded.' },
    ]);
  });

  it('requirement blocks', () => {
    const lab = 'IA.L2-3.5.3';
    const fips = 'SC.L2-3.13.11';
    const partial = requirement('AC.L2-3.1.5');
    const [firstObjective] = partial.objectives;
    const model = modelOf({
      statuses: {
        ...results('met', ['AC.L2-3.1.1', partial.id]),
        ...(firstObjective === undefined ? {} : { [firstObjective.id]: 'na' as const }),
        ...results('na', ['AC.L2-3.1.2']),
        ...results('not_met', ['AC.L2-3.1.3', lab]),
        '3.1.4[a]': 'met',
      },
      states: [
        state('AC.L2-3.1.1', {
          implementationStatement: 'We use SSO.\nEvery account is reviewed.',
          owner: { id: 'u-ada', displayName: 'Ada Admin', active: true },
        }),
        state('AC.L2-3.1.2', { naRationale: 'No such accounts.', implementationStatement: '  ' }),
        state('AC.L2-3.1.3', {
          owner: { id: 'u-gh', displayName: 'Grace Hopper', active: false },
          plannedImplementation: 'Buy a proxy.',
          naRationale: ' \n ',
        }),
        state(lab, { implementationLevel: 'partial' }),
        state(fips, { implementationLevel: 'none' }),
      ],
      items: [poamItem('AC.L2-3.1.3', { plan: 'Turn on MFA.', due: '2027-02-01' })],
      policies: [policy('Access Policy', ['AC.L2-3.1.1'])],
      evidence: [evidence('Account review', ['3.1.1[a]', '3.1.1[b]'])],
    });

    // NIST wording: a met requirement with some N/A objectives is still Implemented.
    const status = (id: string) => fieldOf(requirementSection(model, id), 'Status');
    expect(status('AC.L2-3.1.1')).toBe('Implemented');
    expect(status(partial.id)).toBe('Implemented');
    expect(status('AC.L2-3.1.2')).toBe('Not applicable');
    expect(status('AC.L2-3.1.3')).toBe('Planned to be implemented');
    expect(status('AC.L2-3.1.4')).toBe('Not yet assessed');
    expect(status('AC.L2-3.1.6')).toBe('Not yet assessed');

    // Each requirement starts with its text, and keeps points, level and owner.
    const ac1 = requirementSection(model, 'AC.L2-3.1.1');
    expect(ac1[0]).toEqual({ kind: 'paragraph', text: requirement('AC.L2-3.1.1').text });
    for (const r of catalog.requirements) {
      expect(fieldOf(requirementSection(model, r.id), 'Points')).toBe(
        r.scoring.kind === 'points' ? String(r.scoring.points) : 'Prerequisite',
      );
    }
    const withLevel = catalog.requirements
      .filter((r) => fieldOf(requirementSection(model, r.id), 'Implementation level') !== undefined)
      .map((r) => r.id);
    expect(withLevel).toEqual([lab, fips]);
    expect(fieldOf(requirementSection(model, fips), 'Implementation level')).toBe(
      'Not implemented',
    );
    expect(fieldOf(ac1, 'Owner')).toBe('Ada Admin');
    expect(fieldOf(requirementSection(model, 'AC.L2-3.1.3'), 'Owner')).toBe(
      'Grace Hopper (inactive)',
    );
    expect(fieldOf(requirementSection(model, 'AC.L2-3.1.2'), 'Owner')).toBe('Unassigned');

    // The three texts, in order, with their fallbacks.
    const labelsOf = (blocks: SspBlock[]) =>
      blocks.flatMap((b) => (b.kind === 'text' ? [b.label] : []));
    expect(labelsOf(ac1)).toEqual([
      'Current implementation',
      'Planned implementation',
      'Rationale if not applicable',
    ]);
    expect(textOf(ac1, 'Current implementation')).toBe('We use SSO.\nEvery account is reviewed.');
    expect(textOf(ac1, 'Planned implementation')).toBe('None recorded.');
    expect(textOf(ac1, 'Rationale if not applicable')).toBe('None recorded.');
    const ac2 = requirementSection(model, 'AC.L2-3.1.2');
    expect(textOf(ac2, 'Current implementation')).toBe('No implementation statement recorded.');
    expect(textOf(ac2, 'Rationale if not applicable')).toBe('No such accounts.');
    const ac3 = requirementSection(model, 'AC.L2-3.1.3');
    expect(textOf(ac3, 'Current implementation')).toBe('No implementation statement recorded.');
    expect(textOf(ac3, 'Planned implementation')).toBe('Buy a proxy.');
    expect(textOf(ac3, 'Rationale if not applicable')).toBe('None recorded.');
    // No state at all.
    const ac6 = requirementSection(model, 'AC.L2-3.1.6');
    expect(textOf(ac6, 'Current implementation')).toBe('No implementation statement recorded.');
    expect(textOf(ac6, 'Planned implementation')).toBe('None recorded.');

    // Policies, evidence and the open POA&M item stay.
    expect(listOf(ac1, 'Policies')).toEqual(['Access Policy']);
    expect(listOf(ac1, 'Evidence')).toEqual(['Account review']);
    expect(listOf(ac2, 'Policies')).toBe('None linked');
    expect(fieldOf(ac3, 'Open POA&M item')).toBe('Due 2027-02-01');
    expect(textOf(ac3, 'Plan')).toBe('Turn on MFA.');
    expect(fieldOf(ac1, 'Open POA&M item')).toBeUndefined();

    // The objectives moved to Appendix B: no table anywhere in section 3.
    expect(tablesOf(sectionOf(model, '3. Requirements'))).toEqual([]);
  });

  it('diagrams', () => {
    const png = pngOf(1248, 600);
    const jpeg = jpegOf(300, 900);
    const network = fileLink('Boundary', 'net.png', {
      evidence: { id: 'e-net', title: 'Network map', containsCui: false },
      version: 2,
    }, { version: 2, sha256: 'abc123' });
    const pdf = fileLink('Flow', 'flow.pdf', { kind: 'data_flow' }, { sha256: 'def456' });
    // The api never sends this, but a CUI item is never embedded, whatever the input says.
    const cuiFile = fileLink('Secret', 'secret.png', {
      evidence: { id: 'e-cui', title: 'CUI map', containsCui: true },
      embeddable: true,
    });
    const cuiPlace = fileLink(
      'Vault',
      'unused',
      {
        kind: 'data_flow',
        evidence: { id: 'e-vault', title: 'CUI flow', containsCui: true },
        embeddable: false,
      },
      { kind: 'reference', fileName: null, size: null, sha256: null, location: 'Safe 3' },
    );
    const place = fileLink(
      'Shelf',
      'unused',
      { kind: 'other', embeddable: false },
      { kind: 'reference', fileName: null, size: null, sha256: null, location: 'Binder 7' },
    );
    const pending = fileLink('Pending', 'none', {
      kind: 'other',
      evidence: { id: 'e-draft', title: 'Draft', containsCui: false },
      resolved: null,
      embeddable: false,
    });
    const photo = fileLink('Rack', 'rack.JPG');
    const broken = fileLink('Broken', 'broken.png');
    const missing = fileLink('Missing', 'missing.png');
    const model = modelOf({
      diagrams: [network, cuiFile, pdf, cuiPlace, photo, broken, missing, place, pending],
      images: {
        [network.id]: png,
        [cuiFile.id]: png,
        [photo.id]: jpeg,
        // Bytes that aren't a picture: referenced.
        [broken.id]: new TextEncoder().encode('not an image'),
      },
    });
    const section = sectionOf(model, '2.1 Diagrams');
    expect(section).toEqual([
      { kind: 'image', data: png, type: 'png', width: 624, height: 300, altText: 'Boundary' },
      {
        kind: 'paragraph',
        text: 'Figure 1. Boundary — Network diagram, Network map v2, net.png, SHA-256 abc123, 2026-11-20',
      },
      {
        kind: 'paragraph',
        text: 'Secret — Network diagram: CUI map v1, contains CUI, secret.png, SHA-256 sha-Secret, 2026-11-20',
      },
      {
        kind: 'paragraph',
        text: 'Flow — CUI data flow: Flow file v1, flow.pdf, SHA-256 def456, 2026-11-20',
      },
      {
        kind: 'paragraph',
        text: 'Vault — CUI data flow: CUI flow v1, contains CUI, kept at Safe 3, 2026-11-20',
      },
      { kind: 'image', data: jpeg, type: 'jpg', width: 288, height: 864, altText: 'Rack' },
      {
        kind: 'paragraph',
        text: 'Figure 2. Rack — Network diagram, Rack file v1, rack.JPG, SHA-256 sha-Rack, 2026-11-20',
      },
      {
        kind: 'paragraph',
        text: "Broken — Network diagram: Broken file v1, broken.png, SHA-256 sha-Broken, 2026-11-20 (referenced: the image couldn't be read)",
      },
      {
        kind: 'paragraph',
        text: "Missing — Network diagram: Missing file v1, missing.png, SHA-256 sha-Missing, 2026-11-20 (referenced: the image couldn't be read)",
      },
      {
        kind: 'paragraph',
        text: 'Shelf — Other diagram: Shelf file v1, kept at Binder 7, 2026-11-20',
      },
      { kind: 'paragraph', text: 'Pending — Other diagram: Draft, no version recorded yet' },
    ]);

    // The limit: only the first N embeddable links are embedded; the rest say why.
    const second = fileLink('Second', 'second.png');
    const third = fileLink('Third', 'third.png');
    const limited = sectionOf(
      modelOf({
        diagrams: [network, pdf, second, third],
        images: { [network.id]: png, [second.id]: png, [third.id]: png },
        maxEmbeddedImages: 2,
      }),
      '2.1 Diagrams',
    );
    expect(limited.filter((b) => b.kind === 'image')).toHaveLength(2);
    expect(paragraphs(limited)).toEqual([
      'Figure 1. Boundary — Network diagram, Network map v2, net.png, SHA-256 abc123, 2026-11-20',
      'Flow — CUI data flow: Flow file v1, flow.pdf, SHA-256 def456, 2026-11-20',
      'Figure 2. Second — Network diagram, Second file v1, second.png, SHA-256 sha-Second, 2026-11-20',
      'Third — Network diagram: Third file v1, third.png, SHA-256 sha-Third, 2026-11-20 (referenced: the SSP embeds at most 2 images)',
    ]);
    // An unreadable image still takes its slot, so the order of what's embedded never shifts.
    const slotted = sectionOf(
      modelOf({
        diagrams: [broken, second],
        images: { [broken.id]: new Uint8Array([1, 2, 3]), [second.id]: png },
        maxEmbeddedImages: 1,
      }),
      '2.1 Diagrams',
    );
    expect(paragraphs(slotted)).toEqual([
      "Broken — Network diagram: Broken file v1, broken.png, SHA-256 sha-Broken, 2026-11-20 (referenced: the image couldn't be read)",
      'Second — Network diagram: Second file v1, second.png, SHA-256 sha-Second, 2026-11-20 (referenced: the SSP embeds at most 1 images)',
    ]);

    expect(sectionOf(modelOf(), '2.1 Diagrams')).toEqual([
      { kind: 'paragraph', text: 'No diagrams linked.' },
    ]);
  });

  it('record of changes', () => {
    const entry = { date: '2026-11-23', description: 'Exported as SSP-x.docx', madeBy: 'Ada Admin' };
    const model = modelOf({
      control: {
        reviewCadenceMonths: 6,
        nextReviewDue: '2027-05-01',
        revisions: [
          revision('2026-10-01', 'First draft', 'Ada Admin'),
          revision('2026-11-01', 'Added assets', 'Carl Contributor'),
        ],
      },
      exportEntry: entry,
    });
    const section = sectionOf(model, '4. Record of changes');
    expect(fieldOf(section, 'Review cadence')).toBe('every 6 months');
    expect(fieldOf(section, 'Next review due')).toBe('2027-05-01');
    expect(tableOf(section)).toEqual({
      columns: ['Date', 'Description', 'Made by'],
      rows: [
        ['2026-10-01', 'First draft', 'Ada Admin'],
        ['2026-11-01', 'Added assets', 'Carl Contributor'],
        ['2026-11-23', 'Exported as SSP-x.docx', 'Ada Admin'],
      ],
    });
    expect(exportRevisionDescription('SSP-x.docx')).toBe('Exported as SSP-x.docx');

    // A null entry adds no row.
    const stored = modelOf({ control: { revisions: [revision('2026-10-01', 'Draft', 'Ada')] } });
    expect(tableOf(sectionOf(stored, '4. Record of changes')).rows).toEqual([
      ['2026-10-01', 'Draft', 'Ada'],
    ]);
    // Only the entry.
    const only = modelOf({ exportEntry: entry });
    expect(tableOf(sectionOf(only, '4. Record of changes')).rows).toEqual([
      ['2026-11-23', 'Exported as SSP-x.docx', 'Ada Admin'],
    ]);

    // Neither: it says so, and the defaults read plainly.
    const none = sectionOf(modelOf(), '4. Record of changes');
    expect(fieldOf(none, 'Review cadence')).toBe('every 12 months');
    expect(fieldOf(none, 'Next review due')).toBe('Not set');
    expect(tablesOf(none)).toEqual([]);
    expect(paragraphs(none)).toEqual(['No changes recorded.']);

    // A one-month cadence reads in the singular.
    const monthly = sectionOf(modelOf({ control: { reviewCadenceMonths: 1 } }), '4. Record of changes');
    expect(fieldOf(monthly, 'Review cadence')).toBe('every 1 month');
  });

  it('approvals', () => {
    const model = modelOf({
      control: {
        approvals: [
          approval('Pat Owner', 'System owner', '2026-11-01'),
          approval('Sam Officer', 'Security officer', null),
        ],
      },
    });
    expect(sectionOf(model, 'Approvals')).toEqual([
      { kind: 'signature', name: 'Pat Owner', title: 'System owner', date: '2026-11-01' },
      { kind: 'signature', name: 'Sam Officer', title: 'Security officer', date: null },
    ]);
    expect(sectionOf(modelOf(), 'Approvals')).toEqual([
      { kind: 'paragraph', text: 'No approvals recorded.' },
    ]);
  });

  it('appendices', () => {
    // Nothing assessed.
    const empty = modelOf();
    const emptyA = sectionOf(empty, 'Appendix A — Assessment status');
    expect(fieldOf(emptyA, 'Catalog version')).toBe('nist-800-171-r2@1.0.0');
    expect(fieldOf(emptyA, 'Regulation version')).toBe(`cmmc-32-cfr-170@${REGULATION.version}`);
    expect(fieldOf(emptyA, 'Assessment type')).toBe('Self-assessment');
    expect(paragraphs(emptyA)).toEqual([
      'SPRS incomplete: CA.L2-3.12.4 must be Met',
      'No POA&M items recorded.',
    ]);
    expect(fieldOf(emptyA, 'Conditional status')).toBe('Assessment incomplete');
    expect(fieldOf(emptyA, 'Conditional Status Date')).toBeUndefined();
    expect(fieldOf(emptyA, 'Closeout deadline')).toBeUndefined();
    expect(tablesOf(emptyA)).toEqual([
      {
        columns: ['Implementation status', 'Requirements'],
        rows: [
          ['Implemented', '0'],
          ['Planned to be implemented', '0'],
          ['Not applicable', '0'],
          ['Not yet assessed', '110'],
        ],
      },
    ]);
    expect(fieldOf(emptyA, 'Open POA&M items')).toBe('0');
    // The order: versions, SPRS, Conditional, counts, open items, POA&M.
    expect(emptyA.map((b) => (b.kind === 'field' ? b.label : b.kind))).toEqual([
      'Catalog version',
      'Regulation version',
      'Assessment type',
      'paragraph',
      'Conditional status',
      'table',
      'Open POA&M items',
      'paragraph',
    ]);

    // A scored world with a Conditional Status Date and items.
    const onePoint = catalog.requirements.find(
      (r) =>
        r.scoring.kind === 'points' &&
        r.scoring.points === 1 &&
        !REGULATION.poamBarred.value.includes(r.id),
    );
    if (!onePoint) throw new Error('no 1-point requirement');
    const scored = modelOf({
      statuses: {
        ...results('met'),
        ...results('not_met', [onePoint.id]),
        ...results('na', ['AC.L2-3.1.2']),
        '3.1.1[a]': 'na',
      },
      notes: { '3.1.1[b]': 'Checked by hand.' },
      items: [
        poamItem(onePoint.id, { plan: 'Turn on MFA.', due: '2027-02-01' }),
        poamItem('AC.L2-3.1.1', {
          id: 'closed-1',
          status: 'closed',
          requirementStatus: 'met',
          plan: 'Old plan.',
          due: '2026-10-01',
          owner: { id: 'u-gh', displayName: 'Grace Hopper', active: false },
          closeout: {
            closedOn: '2026-11-10',
            note: null,
            confirmedBy: 'organization',
            c3paoName: null,
            recordedBy: ADA,
            late: false,
          },
        }),
      ],
      conditionalStatusDate: '2026-11-01',
    });
    const a = sectionOf(scored, 'Appendix A — Assessment status');
    expect(paragraphs(a)).toEqual(['SPRS 109 / 110']);
    expect(fieldOf(a, 'Conditional status')).toBe('Conditional status reachable');
    expect(fieldOf(a, 'Conditional Status Date')).toBe('2026-11-01');
    expect(fieldOf(a, 'Closeout deadline')).toBe(
      closeoutClock('2026-11-01', TODAY, REGULATION).deadline,
    );
    const [counts, poam] = tablesOf(a);
    expect(counts?.rows).toEqual([
      ['Implemented', '108'],
      ['Planned to be implemented', '1'],
      ['Not applicable', '1'],
      ['Not yet assessed', '0'],
    ]);
    expect(counts?.rows.reduce((sum, row) => sum + Number(row[1]), 0)).toBe(110);
    expect(fieldOf(a, 'Open POA&M items')).toBe('1');
    expect(poam).toEqual({
      columns: ['Requirement', 'Status', 'Due', 'Plan', 'Milestones', 'Owner', 'Closed on'],
      rows: [
        [onePoint.id, 'Open', '2027-02-01', 'Turn on MFA.', '0', 'Unassigned', 'Not closed'],
        [
          'AC.L2-3.1.1',
          'Closed',
          '2026-10-01',
          'Old plan.',
          '0',
          'Grace Hopper (inactive)',
          '2026-11-10',
        ],
      ],
    });

    // Appendix B: a table per family, every objective with its status and note.
    const b = sectionOf(scored, 'Appendix B — Assessment objectives');
    expect(headings(b, 2)).toEqual(
      catalog.families.map((f) => `${f.nistSection} ${f.name} (${f.code})`),
    );
    const tables = tablesOf(b);
    expect(tables).toHaveLength(14);
    for (const table of tables) expect(table.columns).toEqual(['ID', 'Objective', 'Status', 'Note']);
    const rows = tables.flatMap((t) => t.rows);
    expect(rows).toHaveLength(320);
    expect(rows.map((r) => r[0])).toEqual(
      catalog.requirements.flatMap((r) => r.objectives.map((o) => o.id)),
    );
    const ac1 = requirement('AC.L2-3.1.1').objectives;
    expect(rows.slice(0, ac1.length)).toEqual(
      ac1.map((o) => [
        o.id,
        o.text,
        o.id === '3.1.1[a]' ? 'N/A' : 'Met',
        o.id === '3.1.1[b]' ? 'Checked by hand.' : '',
      ]),
    );
    expect(rows.find((r) => r[0] === firstObjectiveOf(onePoint))?.[2]).toBe('Not Met');
    // Nothing assessed reads Not Assessed, with an empty note.
    const emptyRows = tablesOf(sectionOf(empty, 'Appendix B — Assessment objectives')).flatMap(
      (t) => t.rows,
    );
    expect(emptyRows).toHaveLength(320);
    expect(new Set(emptyRows.map((r) => `${r[2] ?? ''}|${r[3] ?? ''}`))).toEqual(
      new Set(['Not Assessed|']),
    );
  });
});

function firstObjectiveOf(r: Requirement): string {
  return r.objectives[0]?.id ?? '';
}
