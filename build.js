#!/usr/bin/node

'use strict';

var fs=require('fs');
var child_process=require('child_process');
var path=require('path');
var os=require('os');

var _env={};
var _recursive={};
var _sandbox=[];

var _jobs={
	max:0,
	run:0,
	cb:undefined,
	begin:false,
	list:[]
};

var _builds={
	run:false,
	hold:[],
	list:[]
};

var _perf={
	begin:Date.now(),
	end:undefined,
	stat:0,
	read:0,
	exists:0,
	exec:0
};

var _feat={
	_includes:new Set(),
	_excludes:new Set(),
	_add(s,p){
		if(typeof(p)=='string')
			p=p.split(',');
		for(let i=0;i<p.length;i++)
			s.add(p[i]);
	},
	_del(s,p){
		if(typeof(p)=='string')
			p=p.split(',');
		for(let i=0;i<p.length;i++)
			s.delete(p[i]);
	},
	include(p,force=true){
		if(force)
			this._del(this._excludes,p);
		this._add(this._includes,p);
	},
	exclude(p){
		this._add(this._excludes,p);
	}
};

function feature(p){
	_feat.include(p,false);
}

function support(n){
	if(_feat._excludes.has(n))
		return false;
	return _feat._includes.has(n);
}

var _fcache={};

var _excludes=new Set();

function push(){
	var it={};
	it.env=JSON.stringify(_env);
	it.cwd=process.cwd();
	_sandbox.push(it);
}

function pop(){
	if(_sandbox.length==0)
		return;
	var it=_sandbox.pop();
	_env=JSON.parse(it.env);
	process.chdir(it.cwd);
}

function _extract(s){
	var begin=-1,end=-1;
	var rec=0;
	for(var i=0;i<s.length;i++){
		if(s[i]=='$' && s[i+1]=='('){
			begin=i;
			rec++;
		} else if(s[i]==')'){
			end=i+1;
			rec--;
			if(rec==0){
				var res={begin:begin,end:end};
				res.name=s.substring(begin+2,end-1);
				return res;
			}
		}
	}
	return null;
}

function _resolv(s){
	if(!s)
		return '';
	do{
		var n=_extract(s);
		if(!n) break;
		s=s.substring(0,n.begin)+$(_resolv(n.name))+s.substring(n.end);
	}while(true);
	return s;
}

function _get_cache(file){
	var key=path.isAbsolute(file)?file:path.join(process.cwd(),file);
	var val=_fcache[key];
	if(!val)
		return _fcache[key]={};
	else
		return val;
}

function _mtime(file){
	var c=_get_cache(file);
	if("mtime" in c){
		return c.mtime;
	}
	_perf.stat++;
	try{
		var stats=fs.statSync(file);
	}catch(e){
		c.mtime=0;
		return 0;
	}
	return c.mtime=stats.mtime.getTime();
}

function _read(file){
	var text=fs.readFileSync(file,{"encoding":"utf8"});
	_perf.read++;
	return text;
}

function _exists(file){
	var c=_get_cache(file);
	if("exists" in c)
		return c.exists;
	_perf.exists++;
	return c.exists=fs.existsSync(file);
}

function _get_includes(cflags){
	var res=[];
	if(!cflags)
		return res;
	var list=cflags.split(' ');
	for(var i=0;i<list.length;i++){
		var s=list[i];
		if(s[0]=='-' && s[1]=='I')
			res.push(s.substring(2));
	}
	return res;
}

function _deps_get(file,vpath,includes,deps,check){
	if(check[file])
		return;
	check[file]=true;
	var text;
	if(file.indexOf('/')>=0 || _exists(file)) {
		text=_read(file);
	} else {
		for(var j=0;j<vpath.length;j++){
			var path=vpath[j]+'/'+file;
			if(_exists(path)){
				text=_read(file);
				break;
			}
		}
		if(j==vpath.length)
			return;
	}
	var list=text.split('\n');
	for(var i=0;i<list.length;i++){
		var s=list[i];
		var res=s.match(/^\s*#include\s*"([^"]*)/);
		if(res){
			var from=0;
		} else {
			res=s.match(/^\s*#include\s*<([^>]*)/);
			if(res){
				var from=1;
			}
		}
		if(!res || res.length!=2)
			continue;
		s=res[1];
		var real;
		if(from==0){
			if(_exists(s)){
				real=s;
			} else {
				for(var j=0;j<vpath.length;j++){
					var path=vpath[j]+'/'+s;
					if(_exists(path)){
						real=path;
						break;
					}
				}
			}
		}
		if(!real){
			for(var j=0;j<includes.length;j++){
				var path=includes[j]+'/'+s;
				if(_exists(path)){
					real=path;
					break;
				}
			}
		}
		if(real){
			for(var j=0;j<deps.length;j++){
				if(deps[j]==real) break;
			}
			if(j==deps.length) {
				deps.push(real);
				_deps_get(real,vpath,includes,deps,check);
			}
		}
	}
}
function _cfile(file){
	return file.match(/\x2E[ch]$/);
}

function _vpath_fill_single(file,vpath){
	if(file.indexOf('/')>=0 || _exists(file))
		return file;
	for(var j=0;j<vpath.length;j++){
		var path=vpath[j]+'/'+file;
		if(_exists(path)){
			return path;
		}
	}
	return file;
}

function _vpath_fill(input,vpath){
	if(!vpath || vpath.length<=0)
		return input;
	if(typeof(input)=="string")
		return _vpath_fill_single(input,vpath);
	var res=[];
	for(var i=0;i<input.length;i++){
		var file=input[i];
		if(file.indexOf('/')>=0){
			res.push(file);
			continue;
		}
		for(var j=0;j<vpath.length;j++){
			var path=vpath[j]+'/'+file;
			if(_exists(path)){
				res.push(path);
				break;
			}
		}
		if(j==vpath.length)
			res.push(file);
	}
	return res;
}

function _deps_changed(input,output){
	if(typeof(output)=="number")
		var output_mtime=output;
	else
		var output_mtime=_mtime(output);

	if(output_mtime<=0){
		return true;
	}
	if(Array.isArray(input)){
		for(var i=0;i<input.length;i++){
			if(input[i]=="") continue;
			var changed=_deps_changed(input[i],output_mtime);
			if(changed)
				return true;
		}
		return false;
	}
	if(_mtime(input)>=output_mtime)
		return true;
	if(!_cfile(input))
		return false;
	var vpath=$('VPATH').split(' ');
	var includes=_get_includes($('CFLAGS'));
	var deps=[];
	var check={};
	_deps_get(input,vpath,includes,deps,check);
	for(var i=0;i<deps.length;i++){
		if(_mtime(deps[i])>=output_mtime){
			return true;
		}
	}
	return false;
}

function env(name,op,val){
	if(Array.isArray(val))
		val=val.join(' ');
	if(op=='='){
		_env[name]=val;
	} else if(op=='?='){
		if(_env[name])
			return;
		_env[name]=_resolv(val);
	} else if(op==':='){
		_env[name]=_resolv(val);
	} else if(op=='+='){
		if(!_env[name])
			_env[name]=val;
		else
			_env[name]+=' '+val;
	} else if(op=='-=') {
		if(!_env[name])
			return;
		var temp=_env[name].split(' ');
		var i=temp.indexOf(val);
		if(i==-1)
			return;
		temp.splice(i,1);
		_env[name]=temp.join(' ');
	} else if(!op){
		var i=name.indexOf('=');
		if(i<=0)
			return;
		val=name.substring(i+1);
		i--;
		if(name[i]=='?' || name[i]==':' || name[i]=='+'||name[i]=='-')
			op=name.substr(i,2);
		else{
			op='=';
			i++;
		}
		name=name.substr(0,i);
		env(name,op,val);
	}
}

function $(name){
	if(_recursive[name])
		return '';
	_recursive[name]=true;
	var res=_resolv(_env[name]);
	_recursive[name]=false;
	return res;
}

function which(name){
	if(process.platform=='win32' && !name.endsWith('.exe'))
		name+='.exe';
	if(fs.existsSync(name))
		return path.resolve(name);
	if(name.includes('/'))
		return null;
	let arr=process.platform=='win32'?process.env.PATH.split(';'):process.env.PATH.split(':');
	for(let one of arr){
		let temp=path.resolve(one,name);
		if(fs.existsSync(temp))
			return temp;
	}
	return null;
}

function exit(code){
	process.exit(code);
}

function cc(input,output){
	if(Array.isArray(input) && !output){
		for(var i=0;i<input.length;i++){
			cc(input[i]);
		}
		return;
	}
	if(Array.isArray(input) && Array.isArray(output) && input.length==output.length){
		for(var i=0;i<input.length;i++){
			cc(input[i],output[i]);
		}
		return;
	}
	var _cc=$('CC') || process.env.CC || 'gcc';
	if(!output)
		output=input.replace(/\.c$/,'.o');
	var vpath=$('VPATH').split(' ');
	input=_vpath_fill(input,vpath);
	if(!_deps_changed(input,output))
		return;
	// Create folder if not exist
	var dir = path.parse(output).dir;
	if (dir && !fs.existsSync(dir)) {
		fs.mkdirSync(dir,{recursive:true});
	}
	if(Array.isArray(input))
		input=input.join(' ');
	if(output.match(/\.o$/))
		var cmd=_cc+' '+$('CFLAGS')+' -c '+input+' -o '+output;
	else
		var cmd=_cc+' '+$('CFLAGS')+" "+$('LDFLAGS')+" "+input+' -o '+output+' '+$('LIBS');
	exec(cmd);
}

function cxx(input,output){
	if(Array.isArray(input) && !output){
		for(var i=0;i<input.length;i++){
			cxx(input[i]);
		}
		return;
	}
	if(Array.isArray(input) && Array.isArray(output) && input.length==output.length){
		for(var i=0;i<input.length;i++){
			cxx(input[i],output[i]);
		}
		return;
	}
	var _cc=$('CXX') || process.env.CXX || 'g++';
	if(!output)
		output=input.replace('.cpp','.o');
	var vpath=$('VPATH').split(' ');
	input=_vpath_fill(input,vpath);
	if(!_deps_changed(input,output))
		return;
	if(output.match(/\.o$/))
		var cmd=_cc+' '+$('CFLAGS')+' '+$('CPPFLAGS')+' -c '+input+' -o '+output;
	else
		var cmd=_cc+' '+$('CFLAGS')+" "+$('LDFLAGS')+" "+input+' -o '+output+' '+$('LIBS');
	exec(cmd);
}

function ld(input,output){
	output=_resolv(output);
	if(Array.isArray(input)){
		if(!_deps_changed(input,output)) {
			return;
		}
		input=input.join(' ');
	} else {
		var temp=input.split(' ');
		if(!_deps_changed(temp,output))
			return;
	}
	var _cc=$('LD') || $('CC') || process.env.CC || 'gcc';
	var cmd=_cc+' '+$('CFLAGS')+' '+$('LDFLAGS')+' '+input+' '+' -o '+output+' '+$('LIBS');
	exec(cmd);
}

function cr(input,output,pattern){
	var vpath=$('VPATH').split(' ');
	input=_vpath_fill(input,vpath);
	if(Array.isArray(output)) {
		if(!Array.isArray(input)) {
			input=[input];
		}
		for(var i=0;i<input.length;i++){
			if(!_deps_changed(input[i],output[i]))
				continue;
			var cmd=pattern.replace('$^',input[i]);
			cmd=cmd.replace('$<',output[0]);
			cmd=cmd.replace('$@',output[i]);
			exec(cmd);
		}
	} else {
		if(!_deps_changed(input,output))
			return;
		if(Array.isArray(input))
			input=input.join(' ');
		var cmd=pattern.replace('$^',input);
		cmd=cmd.replace('$<',output[0]);
		cmd=cmd.replace('$@',output);
		exec(cmd);
	}
}

function bin2c(input,output,options){
	if(typeof(output)=='object'){
		options=output;
		output=null;
	}
	if(!output){
		var i=input.lastIndexOf('.');
		output=input.substr(0,i)+'.c';
	}
	if(!options)
		options={static:true,zero:false};
	if(!options.name)
		options.name=output.replace(/\.c$/,'');
	if(!options.line)
		options.line=16;
	if(!options.indent)
		options.indent='\t';
	var vpath=$('VPATH').split(' ');
	input=_vpath_fill_single(input,vpath);
	try{
		var st_input=fs.statSync(input);
		var st_output=fs.statSync(output);
		if(st_input.mtime.getTime()<st_output.mtime.getTime()){
			return;
		}
	} catch(e){
		if(!st_input){
			console.error(e.message);
			process.exit(-1);
		}
	}
	console.log("bin2c "+input+" "+output);
	var buf=fs.readFileSync(input);
	if(options.transform)
		buf=options.transform(buf);
	var str=buf.toString('hex');
	var text="";
	if(options.static)
		text+='static ';
	if(options.readonly)
		text+='const ';
	text+='unsigned char '+options.name+'[';
	if(options.zero)
		text+=buf.length+1;
	else
		text+=buf.length;
	text+=']={';
	for(var i=0;i<buf.length;i++){
		 if(!(i%options.line)){
			 text+="\n"+options.indent;
		 }
		 text+='0x'+str.substr(i*2,2);
		 if(i!=buf.length-1)
			 text+=',';
	}
	text+="\n};\n";
	fs.writeFileSync(output,text,{encoding:'utf8'});
}

function include(_file){
	var _old=_env["BUILD_FILE"];
	_env["BUILD_FILE"]=path.resolve(_file);
	var _code=_read(_file);
	eval(_code);
	if(_old)
		_env["BUILD_FILE"]=_old;
	else
		delete _env["BUILD_FILE"];
}

function _build_step(){
	if(_builds.hold && _builds.hold.length) {
		_builds.list=_builds.hold.concat(_builds.list);
		_builds.hold=[];
	}

	var _one=_builds.list.shift();
	if(!_one) {
		_perf.end=Date.now();
		var elapse=(_perf.end-_perf.begin)/1000;
		if(elapse>=0.100) {
			console.log("Build completed in "+elapse.toFixed(2)+"s");
			//console.log(_perf);
		}
		return;
	}

	push();

	if(_one.path)
		cd(_one.path);

	var _file=_one.file?_one.file:"build.txt";
	try{
		var _code=_read(_file);
	} catch(e) {
		console.error("no such file '"+e.path+"'");
		process.exit(-1);
	}
	var target=_one.target;
	_builds.run=true;

	var _old=_env["BUILD_FILE"];
	_env["BUILD_FILE"]=path.resolve(_file);
	var _code=_read(_file);

	var r=eval(_code);
	

	if(_old)
		_env["BUILD_FILE"]=_old;
	else
		delete _env["BUILD_FILE"];

	if(_jobs.run<=0){
		if(r && typeof(r)=='object' && r.constructor==Promise){
			r.then(function(){
				_builds.run=false;
				pop();
				process.nextTick(_build_step);
			});
		}else{
			_builds.run=false;
			pop();
			process.nextTick(_build_step);
		}
	}
}

function build(_path,_file,target){
	if(Array.isArray(_path)){
		for(var i=0;i<_path.length;i++){
			if(path.isAbsolute(_path[i]))
				var temp=_path[i];
			else
				var temp=path.join(process.cwd(),_path[i]);
			var it={path:temp,file:_file,target:target};
			if(_builds.run)
				_builds.hold.push(it);
			else
				_builds.list.push(it);
		}
		return;
	}
	if(!_path || _path==".")
		_path=process.cwd();
	else if(!path.isAbsolute(_path))
		_path=path.join(process.cwd(),_path);
	if(Array.isArray(target)){
		for(var i=0;i<target.length;i++){
			if(_excludes.has(target[i]))
				continue;
			var it={path:_path,file:_file,target:target[i]};
			if(_builds.run)
				_builds.hold.push(it);
			else
				_builds.list.push(it);
		}
	} else {
		if(_excludes.has(target))
			return;
		var it={path:_path,file:_file,target:target};
		if(_builds.run)
			_builds.hold.push(it);
		else
			_builds.list.push(it);
	}
}

function shell(command){
	_perf.exec++;
	return child_process.execSync(_resolv(command),{"encoding":"utf8"}).replace(/\n$/,'');
}

function begin(){
	_jobs.run=0;
	_jobs.cb=undefined;
	_jobs.begin=(_jobs.max>=1);
	_jobs.list=[];
}

function end(cb){
	if(!cb){
		return new Promise(end);
	}
	_jobs.begin=false;
	if(cb && _jobs.run==0) {
		cb();
		return;
	}
	if(_jobs.run>0) {
		_jobs.cb=cb;
	}
}

function _exec_jobs(){
	while(_jobs.run<_jobs.max){
		var command=_jobs.list.shift();
		if(!command)
			return;
		console.log(command);
		_jobs.run++;
		_perf.exec++;
		child_process.exec(command,{"encoding":"utf8"},function(error,stdout,stderr){
			if(stdout && stdout.length)
				console.log(stdout);
			if(error) {
				if(stderr && stderr.length)
					console.log(stderr);
				process.exit(-1);
			}
			_jobs.run--;
			_exec_jobs();
			if(_jobs.run==0) {
				var _cb=_jobs.cb;
				_jobs.cb=undefined;
				if(_cb)
					_cb();
				if(_jobs.run==0) {
					// pair with push() at build()
					pop();
					_builds.run=false;
					process.nextTick(_build_step);
				}
			}
		});
	}
}

function exec(command){
	_fcache={};
	command=_resolv(command);
	try{
		if(_jobs.begin){
			_jobs.list.push(command);
			_exec_jobs();
		} else {
			console.log(command);
			_perf.exec++;
			child_process.execSync(command,{"encoding":"utf8","stdio":"inherit"});
		}
	}catch(e){
		//console.log(e);
		process.exit(1);
	}
}

function rm(file){
	if(typeof(file)=='string' && file.startsWith('*.'))
		return rmdir('.',file);
	if(Array.isArray(file)){
		for(var i=0;i<file.length;i++){
			rm(file[i]);
		}
	} else {
		file=_resolv(file);
		try{
			fs.unlinkSync(file);
			console.log("rm "+file);
		}catch(e){
		}
	}
}

function mkdir(_path){
	if(Array.isArray(_path)){
		for(var i=0;i<_path.length;i++){
			mkdir(_path[i]);
		}
		return;
	}
	_path=_resolv(_path);
	try{
		fs.mkdirSync(_path);
		console.log("mkdir "+_path);
	}catch(e){
	}
}

function rmdir(_path,filter){
	if(Array.isArray(_path)){
		for(var i=0;i<_path.length;i++){
			rmdir(_path[i],filter);
		}
		return;
	}
	
	_path=_resolv(_path);
	
	if(filter){
		if(!fs.existsSync(_path))
			return;
		var temp=dir(_path,filter);
		for(var i=0;i<temp.length;i++){
			rm(path.join(_path,temp[i]));
		}
		return;
	}
	
	try{
		fs.rmdirSync(_path);
		console.log("rmdir "+_path);
	} catch(e){
	}
}

function dir(path,filter){
	var temp=fs.readdirSync(path);
	if(!filter || filter=='*') {
		return temp;
	}
	if(filter=='*.c')
		filter=/\.c$/;
	else if(filter=='*.o')
		filter=/\.o$/;
	else if(typeof filter=="string" && filter.substr(0,2)=='*.')
		filter=new RegExp('\\.'+filter.substr(2)+'$');
	var res=[];
	for(var i=0;i<temp.length;i++){
		if(typeof filter=="string"){
			if(temp[i]==filter) {
				res.push(temp[i]);
				break;
			}
		} else if(temp[i].match(filter)){
			res.push(temp[i]);
		}
	}
	return res;
}

function wildcard(input,change){
	var output=[];
	if(typeof(change)=="function"){
		for(var i=0;i<input.length;i++){
			output.push(change(input[i]));
		}
	} else {
		for(var i=0;i<input.length;i++){
			if(change[0]==".c") change[0]=/\.c$/;
			output.push(input[i].replace(change[0],change[1]));
		}
	}
	return output;
}

function cd(dir){
	try{
		process.chdir(dir);
	} catch(e){
		console.error("Failed change to directory '"+path.resolve(dir)+"'");
		process.exit(-1);
	}
}

function basename(name,suffix){
	var temp;
	if(typeof(suffix)=='string')
		return path.basename(name,suffix);
	temp=path.basename(name);
	if(!suffix)
		return temp;
	var end=temp.lastIndexOf('.');
	if(end<=0)
		return temp;
	return temp.substring(0,end);		 
}

function cp(src,dest,options){
	src=_resolv(src);
	dest=_resolv(dest);
	console.log(`cp ${src} ${dest}`);
	options=options || {};
	if(!fs.existsSync(src))
		return;
	var st=fs.statSync(src);
	if(dest[dest.length-1]=='/')
		dest+=basename(src);
	if(st.isDirectory()){
		if(fs.cpSync)
			fs.cpSync(src,dest,{recursive:true});
		else
			exec(`cp -rT ${src} ${dest}`);
	}else{
		if(fs.existsSync(dest)){
			st=fs.statSync(dest);
			if(st.isDirectory())
				dest+='/'+basename(src);
		}
		fs.copyFileSync(src,dest);
	}
}

class CleanTarget{
	constructor(targets){
		if(!targets || !targets.length)
			this.targets=null;
		else
			this.targets=targets;
	}
	valueOf(){
		return "clean";
	}
}

function _run(){
	var argv=process.argv;
	var i=1;
	if(argv[1].indexOf("build")>=0)
		i++;
	var path;
	var file;
	var task=0;
	for(;i<argv.length;i++){
		if(argv[i]=='-C'){
			path=argv[i+1];
			i++;
			continue;
		} else if(argv[i]=='-f'){
			file=argv[i+1];
			i++;
			continue;
		} else if(argv[i]=='-j' && i<argv.length-1) {
			i++;
			_jobs.max=parseInt(argv[i]);
			if(_jobs.max<1)
				_jobs.max=1;
			else if(_jobs.max>os.cpus().length)
				_jobs.max=os.cpus().length;
			continue;
		} else if(argv[i].match(/^-j\d+/)) {
			_jobs.max=parseInt(argv[i].substring(2));
			if(_jobs.max<1)
				_jobs.max=1;
			else if(_jobs.max>os.cpus().length)
				_jobs.max=os.cpus().length;
			continue;
		} else if(argv[i]=='-x' && i<argv.length-1) {
			i++;
			_excludes.add(argv[i]);
			continue;
		} else if(argv[i].startsWith('--with=')) {
			_feat.include(argv[i].substring(7));
			continue;
		} else if(argv[i].startsWith('--without=')) {
			_feat.exclude(argv[i].substring(10));
			continue;
		} else if(argv[i]=='-h') {
			console.log("build [options] [target]");
			console.log("\t-C path");
			console.log("\t-j N jobs at once");
			console.log("\t-f build.txt");
			console.log("\t-x excludes target");
			console.log("\t--with=feat,...");
			console.log("\t--without=feat,...");
			console.log("\t-h help");
			process.exit(0);
		} else if(argv[i].indexOf('=')>0) {
			var t=argv[i].split('=',2);
			env(t[0],'=',t[1]);
			continue;
		}
		if(argv[i]=='clean'){
			build(path,file,new CleanTarget(argv.slice(i+1)));
			file=undefined;
			task++;
			break;
		}else{
			build(path,file,argv[i]);
			file=undefined;
			task++;
		}
	}
	if(task==0)
		build(path,file);
	_build_step();
}

_run();

