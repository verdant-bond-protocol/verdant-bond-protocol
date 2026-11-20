import {
  validateGeoJsonBoundary,
  calculateGeometryAreaHa,
  InvalidGeoJsonError,
} from './geojson-validator';

describe('GeoJSON Boundary Validator (#112)', () => {
  // Approx 10,000 ha square near equator: ~0.09 deg x 0.09 deg
  const validPolygon = {
    type: 'Polygon',
    coordinates: [
      [
        [-62.2, -3.4],
        [-62.2, -3.31],
        [-62.11, -3.31],
        [-62.11, -3.4],
        [-62.2, -3.4],
      ],
    ],
  };

  it('validates a correct polygon geometry and calculates area', () => {
    const result = validateGeoJsonBoundary(validPolygon);
    expect(result.valid).toBe(true);
    expect(result.geometry.type).toBe('Polygon');
    expect(result.areaHa).toBeGreaterThan(950); // ~10,000 ha
    expect(result.boundaryHash).toBeDefined();
  });

  it('accepts GeoJSON Feature wrapper', () => {
    const feature = {
      type: 'Feature',
      geometry: validPolygon,
      properties: { name: 'Test Reserve' },
    };
    const result = validateGeoJsonBoundary(feature);
    expect(result.valid).toBe(true);
    expect(result.geometry.type).toBe('Polygon');
  });

  it('rejects unsupported geometry types (e.g. Point)', () => {
    const point = {
      type: 'Point',
      coordinates: [-62.2, -3.4],
    };
    expect(() => validateGeoJsonBoundary(point)).toThrow(InvalidGeoJsonError);
    expect(() => validateGeoJsonBoundary(point)).toThrow('Invalid geometry type "Point"');
  });

  it('rejects unclosed polygon rings', () => {
    const unclosed = {
      type: 'Polygon',
      coordinates: [
        [
          [-62.2, -3.4],
          [-62.2, -3.31],
          [-62.11, -3.31],
          [-62.11, -3.4], // missing closing point matching first
        ],
      ],
    };
    expect(() => validateGeoJsonBoundary(unclosed)).toThrow(InvalidGeoJsonError);
    expect(() => validateGeoJsonBoundary(unclosed)).toThrow('not closed');
  });

  it('rejects rings with fewer than 4 points', () => {
    const tooFew = {
      type: 'Polygon',
      coordinates: [
        [
          [-62.2, -3.4],
          [-62.2, -3.31],
          [-62.2, -3.4],
        ],
      ],
    };
    expect(() => validateGeoJsonBoundary(tooFew)).toThrow(InvalidGeoJsonError);
    expect(() => validateGeoJsonBoundary(tooFew)).toThrow('at least 4 coordinate points');
  });

  it('rejects impossible latitude or longitude coordinates', () => {
    const invalidLat = {
      type: 'Polygon',
      coordinates: [
        [
          [-62.2, 95], // lat > 90
          [-62.2, -3.31],
          [-62.11, -3.31],
          [-62.11, 95],
          [-62.2, 95],
        ],
      ],
    };
    expect(() => validateGeoJsonBoundary(invalidLat)).toThrow(InvalidGeoJsonError);
    expect(() => validateGeoJsonBoundary(invalidLat)).toThrow('Latitude 95');

    const invalidLng = {
      type: 'Polygon',
      coordinates: [
        [
          [200, -3.4], // lng > 180
          [200, -3.31],
          [-62.11, -3.31],
          [-62.11, -3.4],
          [200, -3.4],
        ],
      ],
    };
    expect(() => validateGeoJsonBoundary(invalidLng)).toThrow(InvalidGeoJsonError);
    expect(() => validateGeoJsonBoundary(invalidLng)).toThrow('Longitude 200');
  });

  it('verifies area sanity against totalAreaHa within tolerance', () => {
    // validPolygon area is ~10,000 ha (0.09 deg x 0.09 deg near the equator)
    const matchingArea = 9900;
    const result = validateGeoJsonBoundary(validPolygon, matchingArea);
    expect(result.valid).toBe(true);

    const mismatchedArea = 50; // reported 50 ha vs ~10,000 ha boundary
    expect(() => validateGeoJsonBoundary(validPolygon, mismatchedArea)).toThrow(InvalidGeoJsonError);
    expect(() => validateGeoJsonBoundary(validPolygon, mismatchedArea)).toThrow('differs from reported totalAreaHa');
  });
});
