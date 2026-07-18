# spherical-delaunay

Spherical Delaunay triangulation via 3D convex hull on the unit sphere, with
O(√N) nearest-neighbor queries via triangle walks and a compact binary
serialization format with an opaque payload slot for consumer-defined metadata.

Developed inside the [tour-guide](https://github.com/ChrisSteinbach/tour-guide)
monorepo and not yet published to npm. Consume it via an `npm pack` tarball or
a `file:` dependency, running `npm run build` first if `dist/` is absent
(`npm pack`/`npm install` also trigger it via the `prepare` script).

## Usage

```ts
import {
  toCartesian,
  convexHull,
  buildTriangulation,
  serializeBinary,
  deserializeBinary,
  createQueryContext,
  findNearestVertices,
  vertexLatLon,
} from "spherical-delaunay";

const tri = buildTriangulation(convexHull(cities.map(toCartesian)));
const buf = serializeBinary(tri); // compact binary tile

const { fd } = deserializeBinary(buf);
const ctx = createQueryContext(fd);
const query = toCartesian({ lat: 48.86, lon: 2.29 });
const { nearestVertex } = findNearestVertices(ctx, query);
console.log(vertexLatLon(fd, nearestVertex));
```

## License

ISC. `src/vendor/robust-predicates/` is public-domain code vendored from
[mourner/robust-predicates](https://github.com/mourner/robust-predicates)
(see its own LICENSE file).
