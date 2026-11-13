# /// script
# requires-python = ">=3.10"
# dependencies = []
# ///
"""Several labels' metrics side by side, per crop and metric, with ratios to a base column.

    uv run tools/kit/table.py <metrics.json | label dir>... [--names a,b,...] [--base <name>]
        [--refs msaa,gt] [--entries glob,...] [--metrics m1,m2] [--crops c1,c2] [--csv out.csv]

Each input is a metrics.json, or a directory holding one (a baseline.mjs label dir
`<root>/<sha>/<label>/`, or a clip-metrics.py output dir). Both formats are read:

  baseline.mjs   { "entries": { "<tier>/<kind>/<clip>[@view]": { "crops": { ... } } } }: one table
                 per entry name;
  clip-metrics   { "clip": [...], "view": ..., "crops": { ... } }: one entry, named
                 "<clip+clip>@<view>".

Every crop holds a role per image ("test", the image measured; "msaa" and, when measured, "gt",
its references), each a dict of metric -> value. A column of the table is an input's "test" values;
the reference roles named by --refs (default msaa,gt) add a column each, read from the first input
that has the entry, because every input of one comparison is measured against the same references.
A column with no value in an entry's table (a reference not measured, an input without that
entry) is left out of it.

Rows are crop x metric, in the first input's order; --crops and --metrics keep only those (in the
order given), --entries keeps the entries whose name matches a glob. When every input holds a
single entry, those entries are compared whatever their names (two clip-metrics runs of different
test dirs); otherwise entries are matched by name.

Columns are named by --names (one per input), else by the input's directory name. --base names the
column the ratios divide by (default: the first reference shown, else the first input); every other
column gets a "<col>/<base>" ratio. A missing value or a zero base gives "-".

Markdown goes to stdout (values to 3 decimals, ratios to 2); --csv writes the same rows at full
precision. Nothing is measured: every number is read from the files, or is a ratio of two of them.
"""

import argparse
import csv
import fnmatch
import json
import sys
from pathlib import Path


def load( arg ):
	p = Path( arg )
	if p.is_dir():
		p = p / 'metrics.json'
	if not p.is_file():
		sys.exit( f'table.py: no metrics.json at {arg}' )
	d = json.loads( p.read_text() )
	if 'entries' in d:
		entries = { k: e.get( 'crops', {} ) for k, e in d[ 'entries' ].items() }
	elif 'crops' in d:
		clip = d.get( 'clip' )
		name = '+'.join( clip ) if isinstance( clip, list ) else str( clip or p.parent.name )
		if d.get( 'view' ):
			name += f'@{d[ "view" ]}'
		entries = { name: d[ 'crops' ] }
	else:
		sys.exit( f'table.py: {p} has neither "entries" nor "crops"' )
	return p.parent.name, entries


def value( crops, crop, role, metric ):
	r = ( crops or {} ).get( crop, {} ).get( role )
	v = r.get( metric ) if isinstance( r, dict ) else None
	return v if isinstance( v, ( int, float ) ) and not isinstance( v, bool ) else None


def ratio( a, b ):
	return None if a is None or b is None or b == 0 else a / b


def csvlist( s ):
	return [ x for x in s.split( ',' ) if x ] if s else None


def main():
	ap = argparse.ArgumentParser( description='several labels\' metrics.json side by side (see the header)' )
	ap.add_argument( 'inputs', nargs='+' )
	ap.add_argument( '--names' )
	ap.add_argument( '--base' )
	ap.add_argument( '--refs', default='msaa,gt' )
	ap.add_argument( '--entries' )
	ap.add_argument( '--metrics' )
	ap.add_argument( '--crops' )
	ap.add_argument( '--csv' )
	a = ap.parse_args()

	loaded = [ load( x ) for x in a.inputs ]
	names = csvlist( a.names ) or [ n for n, _ in loaded ]
	if len( names ) != len( loaded ):
		sys.exit( f'table.py: {len( names )} names for {len( loaded )} inputs' )
	refs = csvlist( a.refs ) or []
	if len( set( names + refs ) ) != len( names ) + len( refs ):
		sys.exit( 'table.py: column names repeat (name the inputs with --names)' )

	# Entry groups: one row group per entry name, each input's crops for it (or None).
	if all( len( e ) == 1 for _, e in loaded ):
		groups = [ ( next( iter( loaded[ 0 ][ 1 ] ) ), [ next( iter( e.values() ) ) for _, e in loaded ] ) ]
	else:
		order = []
		for _, e in loaded:
			order += [ k for k in e if k not in order ]
		groups = [ ( k, [ e.get( k ) for _, e in loaded ] ) for k in order ]
	globs = csvlist( a.entries )
	if globs:
		groups = [ g for g in groups if any( fnmatch.fnmatchcase( g[ 0 ], x ) for x in globs ) ]
	if not groups:
		sys.exit( 'table.py: no entry to show' )

	tables = []
	for name, per in groups:
		first = next( c for c in per if c is not None )
		crops = csvlist( a.crops ) or list( first )
		crops = [ c for c in crops if any( p and c in p for p in per ) ]
		metrics = csvlist( a.metrics )
		if not metrics:
			metrics = []
			for c in crops:
				for role in [ 'test' ] + refs:
					r = first.get( c, {} ).get( role )
					if isinstance( r, dict ):
						metrics += [ m for m in r if m not in metrics and value( first, c, role, m ) is not None ]
		rows = []
		for c in crops:
			for m in metrics:
				cells = { r: value( first, c, r, m ) for r in refs }
				cells.update( { n: value( p, c, 'test', m ) for n, p in zip( names, per ) } )
				rows.append( ( c, m, cells ) )
		shown = [ x for x in refs + names if any( cells[ x ] is not None for _, _, cells in rows ) ]
		tables.append( ( name, shown, rows ) )

	base = a.base
	if base is None:
		base = next( ( r for r in refs if any( r in shown for _, shown, _ in tables ) ), names[ 0 ] )
	elif base not in refs + names:
		sys.exit( f'table.py: --base {base} is not a column ({", ".join( refs + names )})' )

	fmt = lambda v, d: '-' if v is None else f'{v:.{d}f}'
	out = []
	csvrows = []
	for name, shown, rows in tables:
		cols = shown if base in shown else [ base ] + shown
		ratios = [ c for c in cols if c != base ]
		out.append( f'### {name}\n' )
		out.append( '| crop | metric | ' + ' | '.join( cols ) + ' | ' + ' | '.join( f'{c}/{base}' for c in ratios ) + ' |' )
		out.append( '|' + '---|' * ( 2 + len( cols ) + len( ratios ) ) )
		for c, m, cells in rows:
			rs = [ ratio( cells[ x ], cells[ base ] ) for x in ratios ]
			out.append( f'| {c} | {m} | ' + ' | '.join( fmt( cells[ x ], 3 ) for x in cols ) + ' | ' + ' | '.join( fmt( r, 2 ) for r in rs ) + ' |' )
			csvrows.append( dict( entry=name, crop=c, metric=m, **{ x: cells[ x ] for x in cols }, **{ f'{x}/{base}': r for x, r in zip( ratios, rs ) } ) )
		out.append( '' )
	print( '\n'.join( out ) )

	if a.csv:
		fields = []
		for r in csvrows:
			fields += [ k for k in r if k not in fields ]
		with open( a.csv, 'w', newline='' ) as f:
			w = csv.DictWriter( f, fieldnames=fields, restval='' )
			w.writeheader()
			w.writerows( { k: ( '' if v is None else v ) for k, v in r.items() } for r in csvrows )


if __name__ == '__main__':
	main()
