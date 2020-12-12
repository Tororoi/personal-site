//-------------Variables---------------//
//Landing
let landing = document.querySelector(".landing");

//Main
let mainBody = document.querySelector("#main");
mainBody.style.display = "none";

//Event Listeners
landing.addEventListener("click", () => {
    landing.style.webkitAnimationPlayState = "running";
});

landing.addEventListener("webkitAnimationEnd", () => {
    mainBody.style.display = "flex";
    mainBody.style.webkitAnimationPlayState = "running";
});