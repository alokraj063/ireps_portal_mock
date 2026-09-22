$(document).ready(function() {
	$(".postRequest").click(function(e) {
		e.stopPropagation();
        e.preventDefault();
		postRequest(this.getAttribute("url"), this.getAttribute("target"));
       });
});
function postRequest(href, target){
	var parts = href.split('?');
    var url = parts[0];
    var pp, inputs = '';
    if(parts.length>1){
    	 var params = parts[1].split('&');
    	 for(var i = 0, n = params.length; i < n; i++) {
	        pp = params[i].split('=');
	        inputs += '<input type="hidden" name="' + pp[0] + '" value="' + pp[1] + '" />';
	    }
    }
    if(target ==undefined || target==null)
    	target="_self";
   
    var time=new Date().getTime();
    $("body").append('<form action="'+url+'" method="post" id="'+time+'poster" target="'+target+'">'+inputs+'</form>');
    $("#"+time+"poster").submit();
}

function postRequestNewWindow(href,windowAttrib){
	
	if(windowAttrib==undefined){
		windowAttrib='toolbar=0,scrollbars=0,location=1,statusbar=0,menubar=0,resizable=1,width=400,height=300, left = 312,top = 234';
	}
	var parts = href.split('?');
    var url = parts[0];
    var pp, inputs = '';
    if(parts.length>1){
    	 var params = parts[1].split('&');
    	 for(var i = 0, n = params.length; i < n; i++) {
	        pp = params[i].split('=');
	        inputs += '<input type="hidden" name="' + pp[0] + '" value="' + pp[1] + '" />';
	    }
    }
    
    var time=new Date().getTime();
    $("body").append('<form action="'+url+'" method="post" id="'+time+'poster">'+inputs+'</form>');
    
    
    
    var x = document.createElement("FORM");
    
    
    var myForm = document.getElementById(time+'poster');
    myForm.onsubmit = function() {
    	var w = window.open('about:blank','Popup_Window',windowAttrib);
        this.target = 'Popup_Window';
    };
    $("#"+time+"poster").submit();
}
function postRequestNewWindow1(href,windowName,windowAttrib){
	if(windowAttrib==undefined){
		windowAttrib='toolbar=0,scrollbars=0,location=1,statusbar=0,menubar=0,resizable=1,width=400,height=300, left = 312,top = 234';
	}
	var parts = href.split('?');
    var url = parts[0];
    var pp, inputs = '';
    if(parts.length>1){
    	 var params = parts[1].split('&');
    	 for(var i = 0, n = params.length; i < n; i++) {
	        pp = params[i].split('=');
	        inputs += '<input type="hidden" name="' + pp[0] + '" value="' + pp[1] + '" />';
	    }
    }
    
    var time=new Date().getTime();
    $("body").append('<form action="'+url+'" method="post" id="'+time+'poster">'+inputs+'</form>');
    
    
    
    var x = document.createElement("FORM");
    
    
    var myForm = document.getElementById(time+'poster');
    myForm.onsubmit = function() {
    	var w = window.open('about:blank',windowName,windowAttrib);
        this.target = windowName;
    };
    $("#"+time+"poster").submit();
}

$(document).click(function (e){
	$( ".multiSelectOptionContainer" ).each(function( index ) {
		//alert($(this).has(e.target).length);
		if (!$(this).is(e.target)){ // if the target of the click isn't the container...
			//alert($(this).has(e.target).length);
			if($(this).has(e.target).length == 0) {// ... nor a descendant of the container
				$(this).children("div.multiSelectOption").css("display","none");
			}
		}
	});
});
function showHideMultiSelect(id){
	//obj.style.display="none";
	$( ".multiSelectOption" ).each(function( index ) {
		if(id!=undefined && this.id!=id)
		 this.style.display="none";
	});
	$( "#"+id).toggle();
	
}
function setMultiSelectValues(className,setValuesToId,seperator,selectId){
	var arr=multiSelectCountValues(className, seperator);
	var count=arr[0];
	var values=arr[1];
	document.getElementById(setValuesToId).value=values;
	var selected="0";
	if(count>0){
		if($('.'+className).length==count){
			selected="All";
		}else{
			selected=count;
		}
		document.getElementById(selectId).options[0].text=selected+" selected";
	}
	else{
		document.getElementById(selectId).options[0].text=selected+" selected";
	}
}
function multiSelectCountValues(className, seperator){
	var arr=[0,""];
	var count=0;
	var values="";
	$('.'+className).each(function (index,chk) {
		if(chk.checked){
			chk.checked=true;
			if(values.length>0){
				values+=seperator;
			}
			values+=$(chk).val();
			count++;
		}
	 });
	arr[0]=count;
	arr[1]=values;
	return arr;
}
function handleAllChkSelect(className,chkId){
	var isChecked=document.getElementById(chkId).checked;
	$('.'+className).each(function (index,chk) {
		if(!(chk.id==chkId)){
			if(isChecked){
				chk.checked=true;
				chk.disabled=true;
			}else{
				chk.disabled=false;
			}
		}
	 });
}
function markAllChkChecked(className,flag){
	$('.'+className).each(function (index,chk) {
		chk.checked=flag;
	});
}
function getNotifications(tableId,msgType){
	$.ajax({
		type: "POST",
	    url: ajaxDataURL,
	    data: { ajaxMode:"displayNotifications",msgType:msgType},
		dataType:'json',
		success: function(result) {
			if(tableId=="criticalNotification"){
				displayNotificationsForCriticalMessage(result,tableId);
			}else{
				displayNotifications(result,tableId);
			}
		},
	    error: function(result){
	    	//alert("Error===>"+result);
	    }
	});
}
/*
function displayNotifications(result,tableId){
	var table=$('#'+tableId);
	table.empty(); 
	if(result!=null && result!=undefined && result.length>0){
		for(i in result){
			var msg=result[i];
			var row = $("<tr/>");
			var pdfDisplay="";
			//alert(msg.msgHeader);
			var filePath="'"+msg.filePath+"'";
			if(msg.filePath.length>2){
				pdfDisplay=' &nbsp;&nbsp;<a href="#" onclick="openPDF('+filePath+')"><img src="/ireps/images/common/Document.png"  title="Click Here to view Document" height="16" width="15" border="0"></a>';
			}
            row.append($("<td class=' msgText' valign='top' bgcolor='#ffffff' style='text-align:justify;'><font style='font-family:calibri' color='#c00000'>"+msg.msgHeader+" </font>: <font style='font-family:calibri' >"+msg.msgText+pdfDisplay+"</font></td>"));
            row.append($("<td style='line-height:12px'>&nbsp;</td>"));
            table.append(row);
		}
		document.getElementById('img1').style.display = 'block';
	}
}*/
function displayNotifications(result,tableId){
	
	var table=$('#'+tableId);
	table.empty(); 
	if(result!=null && result!=undefined && result.length>0){
		for(i in result){
			var msg=result[i];
			var row = $("<tr />");
			var pdfDisplay="";
			var filePath="'"+msg.filePath+"'";
			if(msg.filePath.length>2){
				pdfDisplay='<a href="#" onclick="openPDF('+filePath+')"><img src="/ireps/images/common/viewPaymentDoc.png"  title="Click Here to view Document" height="13" width="13" border="0"></a>';
			}
            row.append($("<td class=' msgText' width='75%' valign='top' bgcolor='#ffffff' style='text-align:justify;padding: 5px; font-size:15px;'><font style='font-family:calibri' color='#c00000'>"+msg.msgHeader+" </font>: <font style='font-family:calibri' >"+msg.msgText+"</font> &nbsp;"+pdfDisplay+"</td>"));
            table.append(row);
		}
		document.getElementById('img1').style.display = 'block';
	}
}
function displayNotificationsForCriticalMessage(result,tableId){
	var table=$('#'+tableId);
	table.empty(); 
	if(result!=null && result!=undefined && result.length>0){
		for(i in result){
			var msg=result[i];
			var row = $("<tr/>");
			var pdfDisplay="";
			var filePath="'"+msg.filePath+"'";
			if(msg.filePath.length>2){
				pdfDisplay='<a href="#" onclick="openPDF('+filePath+')"><img src="/ireps/images/common/Document.png"  title="Click Here to view Document" height="16" width="15" border="0"></a>';
			}
			row.append($("<td class=' msgText' width='15%' valign='top' bgcolor='#ffffff' style='text-align:justify;'><font style='font-family:calibri;font-size: 14'color='#c00000'>"+msg.msgHeader+" </font>: </td>"));
            row.append($("<td class=' msgText' width='75%' valign='top' bgcolor='#ffffff' style='text-align:justify;'><font style='font-family:calibri;font-size: 14' >"+msg.msgText+"</font></td>"));
            row.append($("<td width='10%' align='center' valign='top' bgcolor='#ffffff'>"+pdfDisplay+"</td>"));
            table.append(row);
		}
		document.getElementById('img1').style.display = 'block';
	}
}
function openPDF(url){
	window.open(url, '', 'toolbar=0,titlebar=0,scrollbars=1,location=0,statusbar=0,menubar=0,resizable=1,width=1000,height=700');
}

/*add on 07.12.21 for open in new tab*/

function postRequestNewtab(href, target){
	var parts = href.split('?');
    var url = parts[0];
    var pp, inputs = '';
    if(parts.length>1){
    	 var params = parts[1].split('&');
    	 for(var i = 0, n = params.length; i < n; i++) {
	        pp = params[i].split('=');
	        inputs += '<input type="hidden" name="' + pp[0] + '" value="' + pp[1] + '" />';
	    }
    }
    if(target ==undefined || target==null)
    	target="_blank";
   
    var time=new Date().getTime();
    $("body").append('<form action="'+url+'" method="post" id="'+time+'poster" target="'+target+'">'+inputs+'</form>');
    $("#"+time+"poster").submit();
}