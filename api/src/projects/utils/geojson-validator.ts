import { createHash } from 'crypto';

export interface GeoJsonValidationResult {
  valid: boolean;
  areaHa: number;
  boundaryHash: string;
  geometry: {
    type: 'Polygon' | 'MultiPolygon';
    coordinates: any[];
  };
}

export class InvalidGeoJsonError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidGeoJsonError';
  }
}

const EARTH_RADIUS_METERS = 6371008.8; // WGS84 mean earth radius
const SQ_METERS_PER_HA = 10000;

function toRadians(deg: number): number {
  return (deg * Math.PI) / 180;
}

/**
 * Calculate the area in square meters of a single ring on a spherical earth model.
 */
function calculateRingAreaMeters(ring: number[][]): number {
  if (ring.length < 4) return 0;
  let total = 0;
  const len = ring.length;

  for (let i = 0; i < len - 1; i++) {
    const p1 = ring[i];
    const p2 = ring[i + 1];
    total += toRadians(p2[0] - p1[0]) * (2 + Math.sin(toRadians(p1[1])) + Math.sin(toRadians(p2[1])));
  }

  return Math.abs((total * EARTH_RADIUS_METERS * EARTH_RADIUS_METERS) / 2.0);
}

/**
 * Calculate total area in hectares of a Polygon or MultiPolygon geometry.
 */
export function calculateGeometryAreaHa(type: string, coordinates: any[]): number {
  let totalSqMeters = 0;

  if (type === 'Polygon') {
    // Outer ring is positive, inner rings (holes) are subtracted
    if (coordinates.length > 0) {
      totalSqMeters += calculateRingAreaMeters(coordinates[0]);
      for (let i = 1; i < coordinates.length; i++) {
        totalSqMeters -= calculateRingAreaMeters(coordinates[i]);
      }
    }
  } else if (type === 'MultiPolygon') {
    for (const polygon of coordinates) {
      if (polygon.length > 0) {
        let polyArea = calculateRingAreaMeters(polygon[0]);
        for (let i = 1; i < polygon.length; i++) {
          polyArea -= calculateRingAreaMeters(polygon[i]);
        }
        totalSqMeters += Math.max(0, polyArea);
      }
    }
  }

  return Math.max(0, totalSqMeters / SQ_METERS_PER_HA);
}

/**
 * Validate a GeoJSON boundary object, ensuring valid geometry type, coordinate bounds,
 * ring closure, and area sanity against expected area within tolerance (default 10%).
 */
export function validateGeoJsonBoundary(
  boundary: unknown,
  expectedAreaHa?: number,
  toleranceFraction = 0.1,
): GeoJsonValidationResult {
  if (!boundary || typeof boundary !== 'object') {
    throw new InvalidGeoJsonError('Boundary must be a valid GeoJSON object');
  }

  const obj = boundary as Record<string, any>;
  let geometry: any = obj;

  if (obj.type === 'Feature') {
    if (!obj.geometry || typeof obj.geometry !== 'object') {
      throw new InvalidGeoJsonError('Feature is missing valid geometry property');
    }
    geometry = obj.geometry;
  } else if (obj.type === 'FeatureCollection') {
    if (!Array.isArray(obj.features) || obj.features.length === 0) {
      throw new InvalidGeoJsonError('FeatureCollection must contain at least one feature');
    }
    geometry = obj.features[0].geometry;
  }

  const { type, coordinates } = geometry;

  if (type !== 'Polygon' && type !== 'MultiPolygon') {
    throw new InvalidGeoJsonError(`Invalid geometry type "${type}". Only Polygon and MultiPolygon are supported.`);
  }

  if (!Array.isArray(coordinates) || coordinates.length === 0) {
    throw new InvalidGeoJsonError('Boundary coordinates array cannot be empty');
  }

  // Validate rings helper
  const validateRing = (ring: any[], ringName: string) => {
    if (!Array.isArray(ring) || ring.length < 4) {
      throw new InvalidGeoJsonError(`${ringName} must contain at least 4 coordinate points`);
    }

    for (let i = 0; i < ring.length; i++) {
      const pt = ring[i];
      if (!Array.isArray(pt) || pt.length < 2 || typeof pt[0] !== 'number' || typeof pt[1] !== 'number') {
        throw new InvalidGeoJsonError(`Invalid coordinate point in ${ringName} at position ${i}`);
      }
      const [lng, lat] = pt;
      if (Number.isNaN(lng) || lng < -180 || lng > 180) {
        throw new InvalidGeoJsonError(`Longitude ${lng} in ${ringName} is out of bounds [-180, 180]`);
      }
      if (Number.isNaN(lat) || lat < -90 || lat > 90) {
        throw new InvalidGeoJsonError(`Latitude ${lat} in ${ringName} is out of bounds [-90, 90]`);
      }
    }

    const first = ring[0];
    const last = ring[ring.length - 1];
    if (Math.abs(first[0] - last[0]) > 1e-6 || Math.abs(first[1] - last[1]) > 1e-6) {
      throw new InvalidGeoJsonError(`${ringName} is not closed (first and last coordinate points must match)`);
    }
  };

  if (type === 'Polygon') {
    coordinates.forEach((ring, idx) => validateRing(ring, `Polygon ring ${idx}`));
  } else if (type === 'MultiPolygon') {
    coordinates.forEach((poly, polyIdx) => {
      if (!Array.isArray(poly) || poly.length === 0) {
        throw new InvalidGeoJsonError(`MultiPolygon polygon ${polyIdx} is empty`);
      }
      poly.forEach((ring, ringIdx) => validateRing(ring, `MultiPolygon polygon ${polyIdx} ring ${ringIdx}`));
    });
  }

  const calculatedAreaHa = calculateGeometryAreaHa(type, coordinates);

  if (expectedAreaHa !== undefined && expectedAreaHa > 0) {
    const diff = Math.abs(calculatedAreaHa - expectedAreaHa);
    const maxAllowedDiff = expectedAreaHa * toleranceFraction;
    if (diff > maxAllowedDiff) {
      throw new InvalidGeoJsonError(
        `Boundary area (${calculatedAreaHa.toFixed(2)} ha) differs from reported totalAreaHa (${expectedAreaHa} ha) beyond allowed ${(toleranceFraction * 100).toFixed(0)}% tolerance`,
      );
    }
  }

  const canonicalStr = JSON.stringify(geometry);
  const boundaryHash = createHash('sha256').update(canonicalStr).digest('hex');

  return {
    valid: true,
    areaHa: Math.round(calculatedAreaHa * 100) / 100,
    boundaryHash,
    geometry: {
      type,
      coordinates,
    },
  };
}
