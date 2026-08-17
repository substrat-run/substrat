import { defineEntities, emitModel } from '@substrat-run/contracts';
import { z } from 'zod';

/**
 * Meridian's entities (#697).
 *
 * Nine tables, two entities. Leave types, the absence ledger, requests, projects,
 * time entries, expenses and holidays are rows this vertical owns — none is ever
 * the subject of an `EntityRef`, and no grant narrows to one.
 *
 * NOT declared: `payroll-run`. It is an entity type this vertical emits events
 * about (`hr.payroll-exported`) with an id minted at emit time and no row
 * anywhere — an event about an occurrence, not about a stored thing. `EntityDef`
 * requires a table, so the registry cannot describe it. Harmless here; it will
 * matter when operations are declared, because `emits.entity` is checked against
 * the registry.
 */
export const meridianEntities = defineEntities({
  employee: {
    table: 'hr_employees',
    fields: z.object({
      id: z.string(),
      number: z.string(),
      name: z.string(),
      email: z.string().nullable(),
      national_id: z.string().nullable(),
      principal_ref: z.string().nullable(),
      started_at: z.string().nullable(),
      created_at: z.string(),
    }),
    key: ['number'],
    // spec §8 names national_id a crypto-shred target; a name and a work email
    // identify the person just as directly.
    erasable: ['national_id', 'name', 'email'],
  },
  'employment-terms': {
    table: 'hr_employment_terms',
    fields: z.object({
      id: z.string(),
      employee_id: z.string(),
      role_title: z.string(),
      monthly_salary: z.string(),
      currency: z.string(),
      scope_pct: z.string(),
      start_date: z.string(),
      notice_months: z.string(),
      created_by: z.string(),
      created_at: z.string(),
    }),
    parents: ['employee'],
    // A salary is the person's, and it is what an erasure must not leave behind.
    erasable: ['monthly_salary'],
  },
});

export const meridianModel = emitModel(meridianEntities);
