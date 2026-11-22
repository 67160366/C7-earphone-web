// One printable part in its print orientation. In the OpenSCAD GUI change `which` and press F6;
// scripts/build-cad.ps1 sets it with -D which="...".
// Names: c7_base c7_tray c7_lid c7_clamp pod_base_L pod_lid_L pod_clamp_L pod_base_R pod_lid_R pod_clamp_R
include <params.scad>
include <lib.scad>

which = "c7_base";

P = part_by_name(which);
assert(P != undef, str("no part named ", which));
part_print(P);
