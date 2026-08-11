import type { Station } from './supabase'

/** How far a stamp may sit from the preset before it reads as elsewhere. */
export const DEFAULT_GEOFENCE_M = 300

/** Metres between two coordinates. Haversine — exact enough at mill scale. */
export function distanceM(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const R = 6371000
  const rad = (d: number) => (d * Math.PI) / 180
  const dLat = rad(bLat - aLat)
  const dLng = rad(bLng - aLng)
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(aLat)) * Math.cos(rad(bLat)) * Math.sin(dLng / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(h))
}

/** "24 m" under a kilometre, "1.3 km" over it. */
export function distanceLabel(m: number): string {
  return m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(1)} km`
}

/**
 * A clock stamp against the station's preset coordinate.
 * Null when there is nothing to check — no preset on the station, or the
 * phone gave no location.
 */
export function stationLocationCheck(
  station: Station | null | undefined,
  coords: { lat: number; lng: number } | null | undefined,
): { ok: boolean; distance: number; limit: number } | null {
  if (!station || station.latitude == null || station.longitude == null || !coords) return null
  const distance = distanceM(coords.lat, coords.lng, station.latitude, station.longitude)
  const limit = station.geofence_m ?? DEFAULT_GEOFENCE_M
  return { ok: distance <= limit, distance, limit }
}
