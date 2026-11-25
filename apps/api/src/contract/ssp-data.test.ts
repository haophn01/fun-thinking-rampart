import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import {
  ASSET_CATEGORIES,
  ASSET_CATEGORY_LABELS,
  DEFAULT_CATEGORIZATION,
  DEFAULT_REVIEW_CADENCE_MONTHS,
  DIAGRAM_KINDS,
  DIAGRAM_KIND_LABELS,
  EMBEDDABLE_IMAGE_EXTENSIONS,
  NIST_STATUSES,
  NIST_STATUS_LABELS,
  PROVIDER_TYPES,
  PROVIDER_TYPE_LABELS,
  RESPONSIBILITY_PARTIES,
  RESPONSIBILITY_PARTY_LABELS,
  REVISION_KINDS,
  SSP_PROFILE_FIELDS,
  assetResponseSchema,
  assetSchema,
  assetsResponseSchema,
  createApprovalRequestSchema,
  createAssetRequestSchema,
  createDiagramLinkRequestSchema,
  createRevisionRequestSchema,
  createServiceProviderRequestSchema,
  createSystemRoleRequestSchema,
  diagramLinkSchema,
  diagramResponseSchema,
  diagramsResponseSchema,
  documentControlSchema,
  isEmbeddableImage,
  nistImplementationStatus,
  patchApprovalRequestSchema,
  patchAssetRequestSchema,
  patchDiagramLinkRequestSchema,
  patchServiceProviderRequestSchema,
  patchSspProfileRequestSchema,
  patchSystemRoleRequestSchema,
  providerResponseSchema,
  providersResponseSchema,
  putResponsibilityRequestSchema,
  responsibilityMatrixSchema,
  responsibilityRowResponseSchema,
  responsibilityRowSchema,
  roleResponseSchema,
  rolesResponseSchema,
  serviceProviderSchema,
  sspApprovalSchema,
  sspProfileResponseSchema,
  sspProfileSchema,
  sspRevisionSchema,
  systemRoleSchema,
} from './index';

const accepts = (schema: z.ZodType, value: unknown) => schema.safeParse(value).success;

/** The paths of the issues a failed parse reports. */
function failedPaths(schema: z.ZodType, value: unknown): (string | number)[][] {
  const result = schema.safeParse(value);
  if (result.success) return [];
  return result.error.issues.map((issue) => issue.path.map((part) => part as string | number));
}

const UUID = '6f1c2d3e-4b5a-4c7d-8e9f-0a1b2c3d4e5f';
const AT = '2026-11-25T10:00:00.000Z';

describe('ssp-data contract', () => {
  it('enums labels and defaults', () => {
    expect(ASSET_CATEGORIES).toEqual(['cui', 'spa', 'crma', 'specialized', 'out_of_scope']);
    expect(ASSET_CATEGORY_LABELS).toEqual({
      cui: 'CUI Assets',
      spa: 'Security Protection Assets',
      crma: 'Contractor Risk Managed Assets',
      specialized: 'Specialized Assets',
      out_of_scope: 'Out-of-Scope Assets',
    });
    expect(Object.keys(ASSET_CATEGORY_LABELS)).toEqual([...ASSET_CATEGORIES]);

    expect(PROVIDER_TYPES).toEqual(['cloud', 'msp', 'mssp', 'other']);
    expect(PROVIDER_TYPE_LABELS).toEqual({
      cloud: 'Cloud service provider',
      msp: 'Managed service provider',
      mssp: 'Managed security service provider',
      other: 'Other',
    });
    expect(Object.keys(PROVIDER_TYPE_LABELS)).toEqual([...PROVIDER_TYPES]);

    expect(RESPONSIBILITY_PARTIES).toEqual(['organization', 'esp', 'shared']);
    expect(RESPONSIBILITY_PARTY_LABELS).toEqual({
      organization: 'Organization',
      esp: 'ESP',
      shared: 'Shared',
    });
    expect(Object.keys(RESPONSIBILITY_PARTY_LABELS)).toEqual([...RESPONSIBILITY_PARTIES]);

    expect(DIAGRAM_KINDS).toEqual(['network', 'data_flow', 'other']);
    expect(DIAGRAM_KIND_LABELS).toEqual({
      network: 'Network diagram',
      data_flow: 'CUI data flow',
      other: 'Other diagram',
    });
    expect(Object.keys(DIAGRAM_KIND_LABELS)).toEqual([...DIAGRAM_KINDS]);

    expect(REVISION_KINDS).toEqual(['export', 'manual']);

    expect(NIST_STATUSES).toEqual(['implemented', 'planned', 'not_applicable', 'not_assessed']);
    expect(NIST_STATUS_LABELS).toEqual({
      implemented: 'Implemented',
      planned: 'Planned to be implemented',
      not_applicable: 'Not applicable',
      not_assessed: 'Not yet assessed',
    });
    expect(Object.keys(NIST_STATUS_LABELS)).toEqual([...NIST_STATUSES]);

    expect(DEFAULT_CATEGORIZATION).toBe('Moderate impact for confidentiality');
    expect(DEFAULT_REVIEW_CADENCE_MONTHS).toBe(12);
    expect(EMBEDDABLE_IMAGE_EXTENSIONS).toEqual(['.png', '.jpg', '.jpeg']);

    expect(SSP_PROFILE_FIELDS).toEqual([
      { key: 'categorization', label: 'Security categorization', group: 'identification' },
      { key: 'securityOfficer', label: 'System security officer', group: 'identification' },
      {
        key: 'securityOfficerEmail',
        label: 'System security officer email',
        group: 'identification',
      },
      { key: 'organizationAddress', label: 'Organization address', group: 'identification' },
      { key: 'organizationPhone', label: 'Organization phone', group: 'identification' },
      { key: 'cuiCategories', label: 'CUI categories (CUI Registry)', group: 'cui' },
      {
        key: 'cuiLocations',
        label: 'Where CUI is stored, processed or transmitted',
        group: 'cui',
      },
      { key: 'cuiEntryExit', label: 'How CUI enters and leaves the system', group: 'cui' },
      { key: 'topologyNarrative', label: 'Network topology', group: 'environment' },
      { key: 'dataFlowNarrative', label: 'CUI data flow', group: 'environment' },
      {
        key: 'inventoryReference',
        label: 'Hardware and software inventory',
        group: 'environment',
      },
      { key: 'maintenanceStatement', label: 'Maintenance and ownership', group: 'environment' },
      { key: 'reviewCadenceMonths', label: 'Review every (months)', group: 'review' },
      { key: 'nextReviewDate', label: 'Next review date', group: 'review' },
    ]);
  });

  it('nist status derivation', () => {
    expect(nistImplementationStatus({ status: 'met', allNa: false })).toBe('implemented');
    expect(nistImplementationStatus({ status: 'met', allNa: true })).toBe('not_applicable');
    expect(nistImplementationStatus({ status: 'not_met', allNa: false })).toBe('planned');
    expect(nistImplementationStatus({ status: 'not_assessed', allNa: false })).toBe('not_assessed');
    // allNa only matters when the requirement is met.
    expect(nistImplementationStatus({ status: 'not_met', allNa: true })).toBe('planned');
    expect(nistImplementationStatus({ status: 'not_assessed', allNa: true })).toBe('not_assessed');
  });

  it('embeddable images', () => {
    for (const name of ['net.png', 'flow.JPG', 'flow.jpeg', 'A.PNG', 'a.b.Jpeg', 'x.jpg.png']) {
      expect(isEmbeddableImage(name), name).toBe(true);
    }
    for (const name of ['a.gif', 'a.pdf', 'a.png.pdf', 'png', '.png.txt', 'a.png ', 'a', '']) {
      expect(isEmbeddableImage(name), name).toBe(false);
    }
  });

  it('profile request rules', () => {
    const patch = patchSspProfileRequestSchema;
    // Cadence: an integer 1-60, never null.
    expect(patch.parse({ reviewCadenceMonths: 1 })).toEqual({ reviewCadenceMonths: 1 });
    expect(patch.parse({ reviewCadenceMonths: 60 })).toEqual({ reviewCadenceMonths: 60 });
    for (const bad of [0, 61, 1.5, null, '12', -1]) {
      expect(accepts(patch, { reviewCadenceMonths: bad }), JSON.stringify(bad)).toBe(false);
    }

    // Phone: 7-50 of digits, + ( ) . - and spaces, with an optional extension.
    const phone = (value: unknown) => accepts(patch, { organizationPhone: value });
    expect(phone('555-1234')).toBe(true);
    expect(phone('5551234')).toBe(true);
    expect(phone('1'.repeat(50))).toBe(true);
    expect(phone('+1 (555) 123-4567')).toBe(true);
    expect(phone('+1 (555) 123-4567 x12')).toBe(true);
    expect(phone('555.123.4567 ext. 123')).toBe(true);
    expect(phone('555-1234 X9')).toBe(true);
    expect(phone('555123')).toBe(false);
    expect(phone('1'.repeat(51))).toBe(false);
    expect(phone('555-CALL-NOW')).toBe(false);
    expect(phone('call 5551234')).toBe(false);
    expect(phone('555-1234 x')).toBe(false);
    expect(phone('555-1234x12')).toBe(false);
    expect(phone('(...) ---')).toBe(false);
    expect(patch.parse({ organizationPhone: '  555-1234  ' })).toEqual({
      organizationPhone: '555-1234',
    });

    // Blank text becomes null, including the categorization (which then reads as the default).
    expect(
      patch.parse({
        categorization: '   ',
        securityOfficer: '',
        organizationPhone: ' ',
        securityOfficerEmail: '\t',
        cuiCategories: ' \n ',
      }),
    ).toEqual({
      categorization: null,
      securityOfficer: null,
      organizationPhone: null,
      securityOfficerEmail: null,
      cuiCategories: null,
    });
    expect(patch.parse({ categorization: null })).toEqual({ categorization: null });
    expect(patch.parse({ securityOfficer: '  Ada  ' })).toEqual({ securityOfficer: 'Ada' });

    // Email uses the shared rule: trimmed and lowercased.
    expect(patch.parse({ securityOfficerEmail: ' ISSO@Example.com ' })).toEqual({
      securityOfficerEmail: 'isso@example.com',
    });
    expect(accepts(patch, { securityOfficerEmail: 'not-an-email' })).toBe(false);

    // Lengths, counted after trimming.
    const limits: [string, number][] = [
      ['categorization', 200],
      ['securityOfficer', 200],
      ['organizationAddress', 1000],
      ['cuiCategories', 20000],
      ['cuiLocations', 20000],
      ['cuiEntryExit', 20000],
      ['topologyNarrative', 20000],
      ['dataFlowNarrative', 20000],
      ['inventoryReference', 2000],
      ['maintenanceStatement', 20000],
    ];
    for (const [key, max] of limits) {
      expect(accepts(patch, { [key]: 'x'.repeat(max) }), `${key} at ${String(max)}`).toBe(true);
      expect(accepts(patch, { [key]: ` ${'x'.repeat(max)} ` }), `${key} padded`).toBe(true);
      expect(accepts(patch, { [key]: 'x'.repeat(max + 1) }), `${key} over`).toBe(false);
    }

    // Next review date: a real date or null; a past date is fine.
    expect(patch.parse({ nextReviewDate: '2020-01-01' })).toEqual({ nextReviewDate: '2020-01-01' });
    expect(patch.parse({ nextReviewDate: null })).toEqual({ nextReviewDate: null });
    expect(accepts(patch, { nextReviewDate: '2027-02-29' })).toBe(false);

    // Strict, and something to change.
    expect(accepts(patch, {})).toBe(false);
    expect(accepts(patch, { securityOfficer: 'Ada', extra: 1 })).toBe(false);
    expect(accepts(patch, { updatedAt: AT })).toBe(false);
    for (const { key } of SSP_PROFILE_FIELDS) {
      expect(patch.safeParse({ [key]: undefined }).success, key).toBe(true);
    }

    // The response is plain: categorization and cadence are always set.
    const profile = {
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
      reviewCadenceMonths: DEFAULT_REVIEW_CADENCE_MONTHS,
      nextReviewDate: null,
      updatedAt: null,
      updatedBy: null,
    };
    expect(sspProfileResponseSchema.parse({ profile })).toEqual({ profile });
    expect(accepts(sspProfileSchema, { ...profile, categorization: null })).toBe(false);
    expect(accepts(sspProfileSchema, { ...profile, reviewCadenceMonths: null })).toBe(false);
    const saved = { ...profile, updatedAt: AT, updatedBy: { id: 'u-1', displayName: 'Ada' } };
    expect(sspProfileSchema.parse(saved)).toEqual(saved);
    // Response schemas don't trim: what the api stored is what goes out.
    expect(sspProfileSchema.parse({ ...profile, securityOfficer: ' Ada ' }).securityOfficer).toBe(
      ' Ada ',
    );
  });

  it('responsibility request rules', () => {
    const put = putResponsibilityRequestSchema;
    expect(put.parse({ party: 'esp', providerId: UUID, note: '  via MSP  ' })).toEqual({
      party: 'esp',
      providerId: UUID,
      note: 'via MSP',
    });
    expect(accepts(put, { party: 'shared', providerId: UUID, note: null })).toBe(true);
    expect(put.parse({ party: 'organization', providerId: null, note: ' ' })).toEqual({
      party: 'organization',
      providerId: null,
      note: null,
    });
    expect(accepts(put, { party: null, providerId: null, note: null })).toBe(true);

    // ESP and shared need a provider; organization and none must not have one.
    for (const party of ['esp', 'shared']) {
      expect(failedPaths(put, { party, providerId: null, note: null }), party).toEqual([
        ['providerId'],
      ]);
    }
    for (const party of ['organization', null]) {
      expect(failedPaths(put, { party, providerId: UUID, note: null }), String(party)).toEqual([
        ['providerId'],
      ]);
    }

    // Every key is required; nothing else is allowed.
    expect(accepts(put, { party: 'organization', providerId: null })).toBe(false);
    expect(accepts(put, { party: 'organization', note: null })).toBe(false);
    expect(accepts(put, { providerId: null, note: null })).toBe(false);
    expect(accepts(put, { party: null, providerId: null, note: null, extra: 1 })).toBe(false);
    expect(accepts(put, { party: 'vendor', providerId: UUID, note: null })).toBe(false);
    expect(accepts(put, { party: 'esp', providerId: 'not-a-uuid', note: null })).toBe(false);
    expect(accepts(put, { party: null, providerId: null, note: 'n'.repeat(4001) })).toBe(false);

    // Responses.
    const empty = { requirementId: 'AC.L2-3.1.1', party: null, provider: null, note: null };
    expect(responsibilityRowSchema.parse({ ...empty, updatedAt: null })).toEqual({
      ...empty,
      updatedAt: null,
    });
    const row = {
      requirementId: 'AC.L2-3.1.1',
      party: 'esp',
      provider: { id: UUID, name: 'Acme MSP' },
      note: null,
      updatedAt: AT,
    };
    expect(responsibilityMatrixSchema.parse({ rows: [row] })).toEqual({ rows: [row] });
    expect(responsibilityRowResponseSchema.parse({ row })).toEqual({ row });
    expect(accepts(responsibilityRowSchema, { ...row, party: 'vendor' })).toBe(false);
  });

  it('collection request rules', () => {
    // Roles.
    const role = { title: 'Administrator', userCount: 2, privileged: true };
    expect(createSystemRoleRequestSchema.parse({ ...role, title: '  Administrator ' })).toEqual({
      ...role,
      person: null,
      responsibilities: null,
    });
    expect(failedPaths(createSystemRoleRequestSchema, { ...role, title: '   ' })).toEqual([
      ['title'],
    ]);
    expect(accepts(createSystemRoleRequestSchema, { ...role, title: 't'.repeat(200) })).toBe(true);
    expect(accepts(createSystemRoleRequestSchema, { ...role, title: 't'.repeat(201) })).toBe(false);
    expect(accepts(createSystemRoleRequestSchema, { ...role, userCount: 0 })).toBe(true);
    expect(accepts(createSystemRoleRequestSchema, { ...role, userCount: 1_000_000 })).toBe(true);
    for (const bad of [-1, 1_000_001, 1.5, '2', null]) {
      expect(accepts(createSystemRoleRequestSchema, { ...role, userCount: bad }), String(bad)).toBe(
        false,
      );
    }
    expect(accepts(createSystemRoleRequestSchema, { title: 'A', userCount: 1 })).toBe(false);
    expect(accepts(createSystemRoleRequestSchema, { ...role, privileged: 'yes' })).toBe(false);
    expect(accepts(createSystemRoleRequestSchema, { ...role, extra: 1 })).toBe(false);
    expect(
      createSystemRoleRequestSchema.parse({ ...role, person: ' ', responsibilities: ' Backups ' }),
    ).toEqual({ ...role, person: null, responsibilities: 'Backups' });
    expect(accepts(createSystemRoleRequestSchema, { ...role, person: 'p'.repeat(201) })).toBe(
      false,
    );
    expect(
      accepts(createSystemRoleRequestSchema, { ...role, responsibilities: 'r'.repeat(4001) }),
    ).toBe(false);
    expect(accepts(patchSystemRoleRequestSchema, {})).toBe(false);
    expect(accepts(patchSystemRoleRequestSchema, { title: ' ' })).toBe(false);
    expect(accepts(patchSystemRoleRequestSchema, { title: null })).toBe(false);
    expect(patchSystemRoleRequestSchema.parse({ person: '' })).toEqual({ person: null });
    expect(accepts(patchSystemRoleRequestSchema, { userCount: -1 })).toBe(false);
    expect(accepts(patchSystemRoleRequestSchema, { privileged: false })).toBe(true);

    // Assets.
    const asset = { name: 'Laptop fleet', category: 'cui' };
    expect(createAssetRequestSchema.parse(asset)).toEqual({
      ...asset,
      assetType: null,
      owner: null,
      location: null,
      treatment: null,
      outOfScopeJustification: null,
    });
    expect(failedPaths(createAssetRequestSchema, { ...asset, name: '' })).toEqual([['name']]);
    expect(accepts(createAssetRequestSchema, { name: 'x' })).toBe(false);
    expect(accepts(createAssetRequestSchema, { ...asset, category: 'other' })).toBe(false);
    for (const key of ['assetType', 'owner', 'location']) {
      expect(accepts(createAssetRequestSchema, { ...asset, [key]: 'x'.repeat(200) })).toBe(true);
      expect(accepts(createAssetRequestSchema, { ...asset, [key]: 'x'.repeat(201) })).toBe(false);
    }
    for (const key of ['treatment', 'outOfScopeJustification']) {
      expect(accepts(createAssetRequestSchema, { ...asset, [key]: 'x'.repeat(4000) })).toBe(true);
      expect(accepts(createAssetRequestSchema, { ...asset, [key]: 'x'.repeat(4001) })).toBe(false);
    }
    // Out of scope needs a justification at creation; another category may keep one.
    expect(
      failedPaths(createAssetRequestSchema, { name: 'Guest Wi-Fi', category: 'out_of_scope' }),
    ).toEqual([['outOfScopeJustification']]);
    expect(
      failedPaths(createAssetRequestSchema, {
        name: 'Guest Wi-Fi',
        category: 'out_of_scope',
        outOfScopeJustification: '  ',
      }),
    ).toEqual([['outOfScopeJustification']]);
    expect(
      accepts(createAssetRequestSchema, {
        name: 'Guest Wi-Fi',
        category: 'out_of_scope',
        outOfScopeJustification: 'Isolated VLAN',
      }),
    ).toBe(true);
    expect(accepts(createAssetRequestSchema, { ...asset, outOfScopeJustification: 'kept' })).toBe(
      true,
    );
    expect(accepts(patchAssetRequestSchema, {})).toBe(false);
    expect(accepts(patchAssetRequestSchema, { name: ' ' })).toBe(false);
    expect(accepts(patchAssetRequestSchema, { category: null })).toBe(false);
    // A patch is judged on the merged row by the api, so the schema alone lets this through.
    expect(accepts(patchAssetRequestSchema, { category: 'out_of_scope' })).toBe(true);
    expect(patchAssetRequestSchema.parse({ owner: ' ' })).toEqual({ owner: null });

    // Service providers.
    const provider = { name: 'Acme MSP', providerType: 'msp' };
    expect(createServiceProviderRequestSchema.parse(provider)).toEqual({
      ...provider,
      fedrampStatus: null,
      services: null,
      agreementReference: null,
    });
    expect(failedPaths(createServiceProviderRequestSchema, { ...provider, name: ' ' })).toEqual([
      ['name'],
    ]);
    expect(accepts(createServiceProviderRequestSchema, { name: 'Acme' })).toBe(false);
    expect(accepts(createServiceProviderRequestSchema, { ...provider, providerType: 'isp' })).toBe(
      false,
    );
    const providerLimits: [string, number][] = [
      ['fedrampStatus', 200],
      ['services', 4000],
      ['agreementReference', 1000],
    ];
    for (const [key, max] of providerLimits) {
      expect(
        accepts(createServiceProviderRequestSchema, { ...provider, [key]: 'x'.repeat(max) }),
      ).toBe(true);
      expect(
        accepts(createServiceProviderRequestSchema, { ...provider, [key]: 'x'.repeat(max + 1) }),
      ).toBe(false);
    }
    expect(accepts(patchServiceProviderRequestSchema, {})).toBe(false);
    expect(
      patchServiceProviderRequestSchema.parse({ fedrampStatus: ' FedRAMP Moderate ' }),
    ).toEqual({ fedrampStatus: 'FedRAMP Moderate' });

    // Diagram links.
    const diagram = { evidenceId: UUID, kind: 'network', caption: 'Office network' };
    expect(createDiagramLinkRequestSchema.parse({ ...diagram, version: null })).toEqual({
      ...diagram,
      version: null,
    });
    expect(createDiagramLinkRequestSchema.parse({ ...diagram, version: 1 })).toEqual({
      ...diagram,
      version: 1,
    });
    for (const bad of [0, -1, 1.5, '1']) {
      expect(
        accepts(createDiagramLinkRequestSchema, { ...diagram, version: bad }),
        String(bad),
      ).toBe(false);
    }
    expect(accepts(createDiagramLinkRequestSchema, diagram)).toBe(false);
    expect(
      failedPaths(createDiagramLinkRequestSchema, { ...diagram, caption: ' ', version: null }),
    ).toEqual([['caption']]);
    expect(
      accepts(createDiagramLinkRequestSchema, {
        ...diagram,
        caption: 'c'.repeat(201),
        version: null,
      }),
    ).toBe(false);
    expect(
      accepts(createDiagramLinkRequestSchema, { ...diagram, evidenceId: 'e-1', version: null }),
    ).toBe(false);
    expect(
      accepts(createDiagramLinkRequestSchema, { ...diagram, kind: 'floor_plan', version: null }),
    ).toBe(false);
    expect(accepts(patchDiagramLinkRequestSchema, {})).toBe(false);
    expect(accepts(patchDiagramLinkRequestSchema, { version: null })).toBe(true);
    expect(accepts(patchDiagramLinkRequestSchema, { version: 0 })).toBe(false);
    // The evidence item can't change: remove and re-link.
    expect(accepts(patchDiagramLinkRequestSchema, { evidenceId: UUID })).toBe(false);

    // Revisions.
    const revision = { date: '2026-11-25', description: 'Annual review' };
    expect(createRevisionRequestSchema.parse(revision)).toEqual(revision);
    expect(createRevisionRequestSchema.parse({ ...revision, madeBy: '  Ada ' })).toEqual({
      ...revision,
      madeBy: 'Ada',
    });
    expect(failedPaths(createRevisionRequestSchema, { ...revision, description: ' ' })).toEqual([
      ['description'],
    ]);
    expect(
      accepts(createRevisionRequestSchema, { ...revision, description: 'd'.repeat(2000) }),
    ).toBe(true);
    expect(
      accepts(createRevisionRequestSchema, { ...revision, description: 'd'.repeat(2001) }),
    ).toBe(false);
    expect(failedPaths(createRevisionRequestSchema, { ...revision, madeBy: ' ' })).toEqual([
      ['madeBy'],
    ]);
    expect(accepts(createRevisionRequestSchema, { ...revision, madeBy: 'm'.repeat(201) })).toBe(
      false,
    );
    expect(accepts(createRevisionRequestSchema, { ...revision, date: '2026-02-30' })).toBe(false);
    expect(accepts(createRevisionRequestSchema, { description: 'x' })).toBe(false);
    expect(accepts(createRevisionRequestSchema, { ...revision, kind: 'export' })).toBe(false);

    // Approvals.
    const approval = { name: 'Ada Lovelace', title: 'CEO', approvedOn: null };
    expect(createApprovalRequestSchema.parse({ ...approval, name: ' Ada Lovelace ' })).toEqual(
      approval,
    );
    expect(failedPaths(createApprovalRequestSchema, { ...approval, name: '' })).toEqual([['name']]);
    expect(failedPaths(createApprovalRequestSchema, { ...approval, title: ' ' })).toEqual([
      ['title'],
    ]);
    expect(accepts(createApprovalRequestSchema, { ...approval, approvedOn: '2026-11-25' })).toBe(
      true,
    );
    expect(accepts(createApprovalRequestSchema, { ...approval, approvedOn: '2026-13-01' })).toBe(
      false,
    );
    expect(accepts(createApprovalRequestSchema, { name: 'Ada', title: 'CEO' })).toBe(false);
    expect(accepts(patchApprovalRequestSchema, {})).toBe(false);
    expect(accepts(patchApprovalRequestSchema, { approvedOn: null })).toBe(true);
    expect(accepts(patchApprovalRequestSchema, { name: ' ' })).toBe(false);
  });

  it('collection responses', () => {
    const roleRow = {
      id: UUID,
      title: 'Administrator',
      person: null,
      responsibilities: null,
      userCount: 2,
      privileged: true,
      createdAt: AT,
      updatedAt: AT,
    };
    expect(systemRoleSchema.parse(roleRow)).toEqual(roleRow);
    const roles = { roles: [roleRow], totals: { users: 2, privilegedUsers: 2 } };
    expect(rolesResponseSchema.parse(roles)).toEqual(roles);
    expect(accepts(rolesResponseSchema, { roles: [roleRow] })).toBe(false);
    expect(roleResponseSchema.parse({ role: roleRow })).toEqual({ role: roleRow });

    const assetRow = {
      id: UUID,
      name: 'Laptops',
      category: 'cui',
      assetType: null,
      owner: null,
      location: null,
      treatment: null,
      outOfScopeJustification: null,
      createdAt: AT,
      updatedAt: AT,
    };
    expect(assetSchema.parse(assetRow)).toEqual(assetRow);
    expect(assetsResponseSchema.parse({ assets: [assetRow] })).toEqual({ assets: [assetRow] });
    expect(assetResponseSchema.parse({ asset: assetRow })).toEqual({ asset: assetRow });

    const providerRow = {
      id: UUID,
      name: 'Acme',
      providerType: 'cloud',
      fedrampStatus: 'FedRAMP Moderate',
      services: null,
      agreementReference: null,
      createdAt: AT,
      updatedAt: AT,
    };
    expect(serviceProviderSchema.parse(providerRow)).toEqual(providerRow);
    expect(providersResponseSchema.parse({ providers: [providerRow] })).toEqual({
      providers: [providerRow],
    });
    expect(providerResponseSchema.parse({ provider: providerRow })).toEqual({
      provider: providerRow,
    });

    const link = {
      id: UUID,
      kind: 'network',
      caption: 'Office network',
      evidence: { id: UUID, title: 'Network diagram', containsCui: false },
      version: null,
      resolved: {
        version: 2,
        kind: 'file',
        fileName: 'net.png',
        size: 10,
        sha256: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
        location: null,
        createdAt: AT,
      },
      embeddable: true,
      createdAt: AT,
      updatedAt: AT,
    };
    expect(diagramLinkSchema.parse(link)).toEqual(link);
    expect(diagramLinkSchema.parse({ ...link, resolved: null, embeddable: false }).resolved).toBe(
      null,
    );
    const reference = {
      ...link,
      version: 1,
      resolved: {
        version: 1,
        kind: 'reference',
        fileName: null,
        size: null,
        sha256: null,
        location: 'SharePoint/CUI/diagram',
        createdAt: AT,
      },
      embeddable: false,
    };
    expect(diagramLinkSchema.parse(reference)).toEqual(reference);
    expect(
      accepts(diagramLinkSchema, { ...link, resolved: { ...link.resolved, kind: 'url' } }),
    ).toBe(false);
    expect(diagramsResponseSchema.parse({ diagrams: [link] })).toEqual({ diagrams: [link] });
    expect(diagramResponseSchema.parse({ diagram: link })).toEqual({ diagram: link });

    const revision = {
      id: UUID,
      kind: 'manual',
      date: '2026-11-25',
      description: 'Annual review',
      madeBy: 'Ada',
      createdAt: AT,
    };
    expect(sspRevisionSchema.parse(revision)).toEqual(revision);
    expect(accepts(sspRevisionSchema, { ...revision, kind: 'import' })).toBe(false);
    const approval = {
      id: UUID,
      name: 'Ada',
      title: 'CEO',
      approvedOn: null,
      createdAt: AT,
      updatedAt: AT,
    };
    expect(sspApprovalSchema.parse(approval)).toEqual(approval);
    const control = {
      reviewCadenceMonths: 12,
      nextReviewDate: null,
      nextReviewDue: '2027-11-25',
      daysToReview: -1,
      reviewOverdue: true,
      revisions: [revision],
      approvals: [approval],
    };
    expect(documentControlSchema.parse(control)).toEqual(control);
    expect(
      documentControlSchema.parse({
        ...control,
        nextReviewDue: null,
        daysToReview: null,
        reviewOverdue: false,
      }).daysToReview,
    ).toBe(null);
    expect(accepts(documentControlSchema, { ...control, daysToReview: 1.5 })).toBe(false);
  });
});
