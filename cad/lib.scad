// Turns the part data in params.scad into solids. Primitives and steps are explained in scripts/cad-model.mjs.
$fa = 6;
$fs = 0.25;

module rbox(x0, y0, z0, x1, y1, z1, r) {
  rr = min(r, (x1 - x0) / 2 - 0.01, (y1 - y0) / 2 - 0.01);
  translate([0, 0, z0]) linear_extrude(z1 - z0)
    hull() for (x = [x0 + rr, x1 - rr], y = [y0 + rr, y1 - rr]) translate([x, y]) circle(rr);
}

module prim(p) {
  if (p[0] == "box") translate([p[1], p[2], p[3]]) cube([p[4] - p[1], p[5] - p[2], p[6] - p[3]]);
  else if (p[0] == "rbox") rbox(p[1], p[2], p[3], p[4], p[5], p[6], p[7]);
  else if (p[0] == "cyl") translate([p[1], p[2], p[3]]) cylinder(h = p[4] - p[3], r = p[5]);
  else if (p[0] == "tri") translate([0, 0, p[2]]) linear_extrude(p[3] - p[2]) polygon(p[1]);
}

module prims(list) { for (p = list) prim(p); }

// steps applied in order: ((s0 - s1) + s2) - s3 ...
module steps(S, n) {
  if (n == 0) prims(S[0][1]);
  else if (S[n][0] == "add") union() { steps(S, n - 1); prims(S[n][1]); }
  else difference() { steps(S, n - 1); prims(S[n][1]); }
}

function part_by_name(name) = [for (p = PARTS) if (p[0] == name) p][0];

// in the layout frame (for the assembly view)
module part_layout(P) { steps(P[3], len(P[3]) - 1); }

// turned to its print orientation, sitting on z = 0
module part_print(P) {
  if (P[1]) translate([0, 0, P[2][1]]) rotate([180, 0, 0]) part_layout(P);
  else translate([0, 0, -P[2][0]]) part_layout(P);
}
