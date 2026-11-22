// Print this first (about 20 minutes) to tune fit and hole sizes for your printer and filament.
// Uses the same CAD_FIT / CAD_HOLE_ADD as the real parts (from params.scad).
//  - row of holes, left to right: M2 pilot, M2.5 pilot, M3 pilot, M2.5 insert, M3 insert, M2.5 clear, M3 clear
//  - a 6 mm post with an M2.5 pilot (same as the box posts): drive an M2.5x6 self-tapping screw into it
//  - three frames for the GY-521 (21 x 16 mm) at fit - 0.1, fit, fit + 0.1: use the one your board drops into
// Engraved marks: one notch = the smaller fit, three notches = the larger fit.
include <params.scad>
include <lib.scad>

H = [1.6, 2.0, 2.5, 3.6, 4.0, 2.9, 3.4];
difference() {
  rbox(0, 0, 0, 70, 14, 3, 2);
  for (i = [0 : len(H) - 1]) translate([5 + i * 10, 7, -1]) cylinder(h = 5, d = H[i] + CAD_HOLE_ADD);
}
translate([0, 16, 0]) difference() {
  union() { rbox(0, 0, 0, 14, 14, 2, 2); translate([7, 7, 0]) cylinder(h = 10, r = 3); }
  translate([7, 7, 2]) cylinder(h = 9, d = 2.0 + CAD_HOLE_ADD);
}
for (k = [0 : 2]) let (f = CAD_FIT - 0.1 + 0.1 * k, w = 21 + 2 * f, h = 16 + 2 * f) translate([18 + k * 28, 16, 0]) {
  difference() {
    rbox(0, 0, 0, w + 3, h + 3, 3, 1.5);
    translate([1.5, 1.5, 1]) cube([w, h, 3]);
    for (n = [0 : k]) translate([3 + n * 2, -0.1, 2.4]) cube([0.8, 1, 1]);
  }
}
