# Horizon

Point your phone at the landscape: every hill, town, tower, castle and wind turbine you can actually see is named, with how far away it is. Without a camera, it draws the panorama from the terrain.

Open **https://lienardquentin.github.io/horizon/** on a phone, tap *Start here, with the camera*, and allow the camera, motion sensors and location. Or look around from one of the viewpoints on the first screen.

How it works: the terrain for 40 km around you comes as height tiles (about 24 m a pixel within 4.5 km, 100 m beyond). From your eye, 720 lines of sight run out across it, one every half degree, with the Earth curving away below them and the air bending them slightly back down; the highest angle each reaches is the skyline. A place gets a label only if its own line of sight is clear. Everything is computed on the phone.

Search any place, near or far (the magnifier), or tap one in view, then **Walk**, **Cycle** or **Drive**: the route is laid on the landscape, solid where you can see it and dashed behind the hills, with a marker every kilometre. With the camera on, the view follows you as you go.

If the gold skyline sits beside the real one (phone compasses are off by a few degrees), tap the crosshair and drag sideways until they match. On a tower or a viewing platform, raise *Your height above the ground* in the settings.

## Credits

- Routes: [FOSSGIS routing servers](https://routing.openstreetmap.de) (OSRM); search: [Photon](https://photon.komoot.io) by Komoot; both from OpenStreetMap data.
- Places: © [OpenStreetMap contributors](https://www.openstreetmap.org/copyright), through the [Overpass API](https://overpass-api.de) (data under the ODbL).
- Terrain: [Terrain Tiles](https://registry.opendata.aws/terrain-tiles/) on AWS Open Data, from SRTM, EU-DEM (produced using Copernicus data and information funded by the European Union) and other sources.
