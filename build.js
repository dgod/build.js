var fs=require('fs');
var util=require('util');
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

function _mtime(file){
	try{
		var stats=fs.statSync(file);
	}catch(e){
		return 0;
	}
	return stats.mtime.getTime();
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
	if(file.indexOf('/')>=0 || fs.existsSync(file)) {
		var text=fs.readFileSync(file,{"encoding":"utf-8"});
	} else {
		for(var j=0;j<vpath.length;j++){
			var path=vpath[j]+'/'+file;
			if(fs.existsSync(path)){
				var text=fs.readFileSync(file,{"encoding":"utf-8"});
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
			if(fs.existsSync(s)){
				real=s;
			} else {
				for(var j=0;j<vpath.length;j++){
					var path=vpath[j]+'/'+s;
					if(fs.existsSync(path)){
						real=path;
						break;
					}
				}
			}
		}
		if(!real){
			for(var j=0;j<includes.length;j++){
				var path=includes[j]+'/'+s;
				if(fs.existsSync(path)){
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
	if(file.indexOf('/')>=0 || fs.existsSync(file))
		return file;
	for(var j=0;j<vpath.length;j++){
		var path=vpath[j]+'/'+file;
		if(fs.existsSync(path)){
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
			if(fs.existsSync(path)){
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
	if(util.isArray(input)){
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
		if(_mtime(deps[i])>=output_mtime)
			return true;
	}
	return false;
}

function env(name,op,val){
	if(util.isArray(val))
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
	} else if(!op){
		var i=name.indexOf('=');
		if(i<=0)
			return;
		val=name.substring(i+1);
		i--;
		if(name[i]=='?' || name[i]==':' || name[i]=='+')
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

function cc(input,output){
	if(util.isArray(input) && !output){
		for(var i=0;i<input.length;i++){
			cc(input[i]);
		}
		return;
	}
	if(util.isArray(input) && util.isArray(output) && input.length==output.length){
		for(var i=0;i<input.length;i++){
			cc(input[i],output[i]);
		}
		return;
	}
	var _cc=$('CC');
	if(_cc.length==0) _cc='gcc';
	if(!output)
		output=input.replace('.c','.o');
	var vpath=$('VPATH').split(' ');
	input=_vpath_fill(input,vpath);
	if(!_deps_changed(input,output))
		return;
	var cmd=_cc+' '+$('CFLAGS')+' -c '+input+' -o '+output;
	exec(cmd);
}

function ld(input,output){
	output=_resolv(output);
	if(util.isArray(input)){
		if(!_deps_changed(input,output)) {
			return;
		}
		input=input.join(' ');
	} else {
		var temp=input.split(' ');
		if(!_deps_changed(temp,output))
			return;
	}
	var cc=$('CC');
	if(cc.length==0) cc='gcc';
	var cmd=cc+' '+$('CFLAGS')+' '+$('LDFLAGS')+' '+input+' '+' -o '+output+' '+$('LIBS');
	exec(cmd);
}

function cr(input,output,pattern){
	var vpath=$('VPATH').split(' ');
	input=_vpath_fill(input,vpath);
	if(util.isArray(output)) {
		if(!util.isArray(input)) {
			input=[input];
		}
		for(var i=0;i<input.length;i++){
			if(!_deps_changed(input[i],output[i]))
				continue;
			var cmd=pattern.replace('$^',input[i]).replace('$@',output[i]);
			exec(cmd);
		}
	} else {
		if(!_deps_changed(input,output))
			return;
		if(util.isArray(input))
			input=input.join(' ');
		var cmd=pattern.replace('$^',input).replace('$@',output);
		exec(cmd);
	}
}

function include(_file){
	var _code=fs.readFileSync(_file,{"encoding":"utf-8"});
	eval(_code);
}

function _build_step(){
	if(_builds.hold && _builds.hold.length) {
		_builds.list=_builds.hold.concat(_builds.list);
		_builds.hold=[];
	}

	var _one=_builds.list.shift();
	if(!_one)
		return;

	push();

	if(_one.path)
		cd(_one.path);

	var _file=_one.file?_one.file:"build.txt";
	try{
		var _code=fs.readFileSync(_file,{"encoding":"utf-8"});
	} catch(e) {
		console.error("no such file '"+e.path+"'");
		process.exit(-1);
	}
	var target=_one.target;
	_builds.run=true;
	eval(_code);
	if(_jobs.run<=0){
		_builds.run=false;
		pop();
		process.nextTick(_build_step);
	}
}

function build(_path,_file,target){
	if(util.isArray(_path)){
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
		_path=path.join(process.cwd,_path);
	if(util.isArray(target)){
		for(var i=0;i<target.length;i++){
			var it={path:_path,file:_file,target:target[i]};
			if(_builds.run)
				_builds.hold.push(it);
			else
				_builds.list.push(it);
		}
	} else {
		var it={path:_path,file:_file,target:target};
		if(_builds.run)
			_builds.hold.push(it);
		else
			_builds.list.push(it);
	}
}

function shell(command){
	return child_process.execSync(_resolv(command),{"encoding":"utf-8"}).replace(/\n$/,'');
}

function begin(){
	_jobs.run=0;
	_jobs.cb=undefined;
	_jobs.begin=(_jobs.max>=1);
	_jobs.list=[];
}

function end(cb){
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
		child_process.exec(command,{"encoding":"utf-8"},function(error,stdout,stderr){
			if(stdout && stdout.length)
				console.log(stdout);
			if(error) {
				if(stderr && stderr.length)
					console.log(stderr);
				process.exit(-1);
			}
			_jobs.run--;
			_exec_jobs();
			if(_jobs.run==0 && _jobs.cb) {
				var _cb=_jobs.cb;
				_jobs.cb=undefined;
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
	command=_resolv(command);
	try{
		if(_jobs.begin){
			_jobs.list.push(command);
			_exec_jobs();
		} else {
			console.log(command);
			var text=child_process.execSync(command,{"encoding":"utf-8"});
			if(text && text.length>0)
				console.log(text);
		}
	}catch(e){
		process.exit(1);
	}
}

function pkgconfig(args){
	return shell("pkg-config "+args);
}

function rm(file){
	if(util.isArray(file)){
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

function rmdir(_path,filter){
	if(util.isArray(_path)){
		for(var i=0;i<_path.length;i++){
			rmdir(_path[i],filter);
		}
		return;
	}
	
	_path=_resolv(_path);
	
	if(filter){
		var temp=dir(_path,filter);
		for(var i=0;i<temp.length;i++){
			rm(path.join(_path,temp[i]));
		}
		return;
	}
	
	try{
		fs.rmdirSync(path);
		console.log("rmdir "+path);
	} catch(e){
	}

}

function dir(path,filter){
	var temp=fs.readdirSync(path);
	if(!filter || filter=='*')
		return temp;
	if(filter=='*.c')
		filter=/\.c$/;
	else if(filter=='*.o')
		filter=/\.o$/;
	var res=[];
	for(var i=0;i<temp.length;i++){
		if(temp[i].match(filter)){
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
			if(change[0]==".c") change[0]=/.c$/;
			output.push(input[i].replace(change[0],change[1]));
		}
	}
	return output;
}

function cd(path){
	try{
		process.chdir(path);
	} catch(e){
		console.error("Failed change to directory '"+path+"'");
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
		} else if(argv[i]=='-h') {
			console.log("build [options] [target]");
			console.log("\t-C path");
			console.log("\t-j N jobs at once");
			console.log("\t-f build.txt");
			console.log("\t-h help");
			process.exit(0);
		} else if(argv[i].indexOf('=')>0) {
			var t=argv[i].split('=',2);
			env(t[0],'=',t[1]);
			continue;
		}
		build(path,file,argv[i]);
		file=undefined;
		task++;
	}
	if(task==0)
		build(path,file);
	_build_step();
}

_run();
