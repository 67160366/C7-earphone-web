<?php
/**
 * Router for the PHP built-in server (scripts/serve.ps1).
 * With -Lan the server answers other devices on the network, so paths that are not part of the site are refused:
 * dot folders (.git, .local, .claude), data/ (the SQLite database and collected sensor data), scripts/, and database files.
 * Everything else is served as usual (return false).
 */
$path = '/' . ltrim(rawurldecode(parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH) ?: '/'), '/');
$path = str_replace('\\', '/', $path);
if (preg_match('#/\.#', $path) || preg_match('#^/(data|scripts)(/|$)#i', $path) || preg_match('#\.(sqlite|sqlite3|db)$#i', $path)) {
    http_response_code(404);
    header('Content-Type: text/plain; charset=utf-8');
    echo 'Not found';
    return true;
}
return false;
