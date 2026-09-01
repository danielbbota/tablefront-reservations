import { createServerSupabase } from '@/lib/supabase/server';
import { asLang, getT } from '@/lib/i18n';
import type { FloorElement, FloorTable, FloorZone, Restaurant } from '@/lib/types';
import type { ZonePayload } from '@/app/floor-actions';
import FloorEditor from './floor-editor';

export default async function FloorPlanPage() {
  const supabase = await createServerSupabase();
  const [{ data: restaurant }, { data: zones }, { data: tables }, { data: elements }] =
    await Promise.all([
      supabase.from('restaurants').select('name, language').single<Pick<Restaurant, 'name' | 'language'>>(),
      supabase.from('floor_zones').select('*').order('sort').returns<FloorZone[]>(),
      supabase.from('floor_tables').select('*').returns<FloorTable[]>(),
      supabase.from('floor_elements').select('*').returns<FloorElement[]>(),
    ]);
  const t = getT(asLang(restaurant?.language));

  const initialZones: ZonePayload[] = (zones ?? []).map((z, i) => ({
    id: z.id,
    name: z.name,
    sort: i,
    tables: (tables ?? [])
      .filter((x) => x.zone_id === z.id)
      .map((x) => ({
        id: x.id,
        name: x.name,
        seats: x.seats,
        shape: x.shape,
        x: x.x,
        y: x.y,
        w: x.w,
        h: x.h,
        rotation: x.rotation,
        combinable_group: x.combinable_group,
      })),
    elements: (elements ?? [])
      .filter((x) => x.zone_id === z.id)
      .map((x) => ({
        id: x.id,
        kind: x.kind,
        label: x.label,
        x: x.x,
        y: x.y,
        w: x.w,
        h: x.h,
        rotation: x.rotation,
      })),
  }));

  const labels = {
    zone: t('floor.zone'),
    addZone: t('floor.addZone'),
    zoneName: t('floor.zoneName'),
    deleteZone: t('floor.deleteZone'),
    addTable: t('floor.addTable'),
    addRound: t('floor.addRound'),
    wall: t('floor.wall'),
    bar: t('floor.bar'),
    door: t('floor.door'),
    plant: t('floor.plant'),
    label: t('floor.label'),
    text: t('floor.text'),
    name: t('floor.name'),
    seats: t('floor.seats'),
    group: t('floor.group'),
    groupHint: t('floor.groupHint'),
    rotate: t('floor.rotate'),
    duplicate: t('floor.duplicate'),
    delete: t('floor.delete'),
    undo: t('floor.undo'),
    save: t('floor.save'),
    saved: t('floor.saved'),
    empty: t('floor.empty'),
  };

  return (
    <div className="tf-rise">
      <h1 className="font-serif text-[1.7rem] font-semibold tracking-tight text-espresso">
        {t('floor.title')}
      </h1>
      <p className="mt-1.5 max-w-xl text-sm text-espresso/60">{t('floor.subtitle')}</p>
      <div className="mt-6">
        <FloorEditor initialZones={initialZones} labels={labels} />
      </div>
    </div>
  );
}
