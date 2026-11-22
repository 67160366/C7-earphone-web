// All parts where they sit when assembled (layout frame), to check by eye. Not for printing.
// explode = 0 shows the closed box; a larger value pulls the layers apart along z.
include <params.scad>
include <lib.scad>

explode = 12;
LIFT = [["c7_clamp", -1], ["c7_base", 0], ["c7_tray", 1], ["c7_lid", 2],
        ["pod_clamp_L", 1], ["pod_base_L", 0], ["pod_lid_L", 2],
        ["pod_clamp_R", 1], ["pod_base_R", 0], ["pod_lid_R", 2]];
SHIFT = [["c7", [0, 0]], ["pod_L", [-80, 0]], ["pod_R", [80, 0]]];
COLOR = [["c7_base", "SteelBlue"], ["c7_tray", "Gold"], ["c7_lid", "LightGray"], ["c7_clamp", "DimGray"]];

function lookup_s(k, table, dflt) = let (m = [for (r = table) if (r[0] == k) r[1]]) len(m) ? m[0] : dflt;
// pod parts end in _L / _R, everything else belongs to the C7 box
function unit_of(name) = name[0] == "p" ? str("pod_", name[len(name) - 1]) : "c7";

for (P = PARTS) {
  sh = lookup_s(unit_of(P[0]), SHIFT, [0, 0]);
  translate([sh[0], sh[1], explode * lookup_s(P[0], LIFT, 0)])
    color(lookup_s(P[0], COLOR, "Teal")) part_layout(P);
}
