# Vendored demo renderer

Three.js 0.186.1 from https://registry.npmjs.org/three/-/three-0.186.1.tgz (MIT; see three/LICENSE).
Selected build modules, OrbitControls, GLTFLoader and its utilities only. GLTFLoader relative utility imports were adjusted to this flattened directory. No npm install/build step or runtime CDN is required. Used by the user page neck model (assets/neck-model.js).

Head model and normal map: Infinite, 3D Head Scan by Lee Perry-Smith, based on triplegangers.com, from https://github.com/mrdoob/three.js/tree/dev/examples/models/gltf/LeePerrySmith. CC BY3.0; original license retained in ../models/head/LeePerrySmith_License.txt. Attribution is shown under the 3D view on the user page. The page crops the scan shoulders in memory, rescales, changes material and articulates the head separately from an illustrative torso. This asset is not a subject-specific anatomical model.

Skin colour map `../models/head/Map-COL.jpg` comes from the same three.js example folder and the same CC BY 3.0 scan. It is used only by `wiring.html` (over-ear headset wiring model, `assets/wiring.js`), which credits the scan on the page.
